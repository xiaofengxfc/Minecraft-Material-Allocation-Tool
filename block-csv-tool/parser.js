/**
 * Litematic → CSV 材料表转换器
 * 
 * 解析 .litematic (GZip + NBT) 文件，提取方块信息并生成 CSV/XLSX 清单。
 * 技术流程：
 *   1. FileReader 读取文件 → ArrayBuffer
 *   2. DecompressionStream 解压 GZip → NBT 原始字节
 *   3. 手写 NBT 解析器 → 结构化数据（支持 TAG_Compound/List/Long_Array 等）
 *   4. 解码 BlockStates packed 长整数数组 → 调色板索引
 *   5. 统计方块 → 生成表格 + 导出 CSV/XLSX
 */

(function () {
    'use strict';

    // ==================== DOM 引用 ====================
    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');
    const infoSection = document.getElementById('info-section');
    const infoGrid = document.getElementById('info-grid');
    const progressSection = document.getElementById('progress-section');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const previewSection = document.getElementById('preview-section');
    const tableBody = document.getElementById('table-body');
    const btnExportCsv = document.getElementById('btn-export-csv');
    const btnExportXlsx = document.getElementById('btn-export-xlsx');
    const btnClear = document.getElementById('btn-clear');

    /** 当前解析结果缓存 */
    let currentData = null; // { info, blocks }  blocks 是 [name, props, count][]

    // ==================== GZip 解压 ====================
    async function gunzip(arrayBuffer) {
        const ds = new DecompressionStream('gzip');
        const writer = new WritableStream({
            write() { /* noop */ }
        });
        const readable = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(arrayBuffer));
                controller.close();
            }
        });
        // 用 pipeThrough 解压
        const decompressedStream = readable.pipeThrough(ds);
        return new Response(decompressedStream).arrayBuffer();
    }

    // ==================== NBT 解析器 ====================
    /**
     * NBT 格式 (Java Edition, big-endian, 无压缩)
     * TAG: 1=Byte, 2=Short, 3=Int, 4=Long, 5=Float, 6=Double,
     *      7=Byte_Array, 8=String, 9=List, 10=Compound,
     *      11=Int_Array, 12=Long_Array
     */
    class NBTReader {
        constructor(buffer) {
            this.data = new DataView(buffer);
            this.pos = 0;
        }

        /** 读取完整 NBT（根 TAG_Compound） */
        readRoot() {
            const tag = this.readByte();
            if (tag !== 10) {
                throw new Error('NBT 根必须是 TAG_Compound，实际 tag=' + tag);
            }
            this.readUTF(); // 根名称（通常为空字符串）
            return this.readCompound();
        }

        readByte() {
            const v = this.data.getUint8(this.pos);
            this.pos += 1;
            return v;
        }

        readShort() {
            const v = this.data.getInt16(this.pos, false); // big-endian
            this.pos += 2;
            return v;
        }

        readInt() {
            const v = this.data.getInt32(this.pos, false);
            this.pos += 4;
            return v;
        }

        readLong() {
            // NBT TAG_Long: signed 64-bit big-endian
            // 使用 getBigInt64 获得完整有符号值（Chrome 67+ / Firefox 68+）
            const v = this.data.getBigInt64(this.pos, false);
            this.pos += 8;
            return v;
        }

        readFloat() {
            const v = this.data.getFloat32(this.pos, false);
            this.pos += 4;
            return v;
        }

        readDouble() {
            const v = this.data.getFloat64(this.pos, false);
            this.pos += 8;
            return v;
        }

        readUTF() {
            const length = this.readShort();
            const bytes = new Uint8Array(this.data.buffer, this.pos, length);
            this.pos += length;
            // Java modified UTF-8（与标准 UTF-8 基本兼容）
            const decoder = new TextDecoder('utf-8', { fatal: false });
            return decoder.decode(bytes);
        }

        readValue(tag) {
            switch (tag) {
                case 0:  return null;
                case 1:  return this.readByte();
                case 2:  return this.readShort();
                case 3:  return this.readInt();
                case 4:  return this.readLong();
                case 5:  return this.readFloat();
                case 6:  return this.readDouble();
                case 7: { // Byte Array
                    const length = this.readInt();
                    const arr = new Uint8Array(this.data.buffer, this.pos, length);
                    this.pos += length;
                    return arr;
                }
                case 8:  return this.readUTF();
                case 9: { // List
                    const itemType = this.readByte();
                    const length = this.readInt();
                    const arr = [];
                    for (let i = 0; i < length; i++) {
                        arr.push(this.readValue(itemType));
                    }
                    return arr;
                }
                case 10: return this.readCompound();
                case 11: { // Int Array
                    const length = this.readInt();
                    const arr = [];
                    for (let i = 0; i < length; i++) {
                        arr.push(this.readInt());
                    }
                    return arr;
                }
                case 12: { // Long Array
                    const length = this.readInt();
                    const arr = [];
                    for (let i = 0; i < length; i++) {
                        arr.push(this.readLong());
                    }
                    return arr;
                }
                default:
                    throw new Error('未知 NBT tag: ' + tag + ' at pos ' + this.pos);
            }
        }

        readCompound() {
            const result = {};
            while (true) {
                const tag = this.readByte();
                if (tag === 0) break;
                const name = this.readUTF();
                result[name] = this.readValue(tag);
            }
            return result;
        }
    }

    // ==================== 方块解码 ====================
    /**
     * 从 BlockStates 长整数数组 + 调色板解码出所有方块索引
     * 
     * Litematica 使用连续比特流编码（Minecraft 1.16+）：
     *   所有 longs 拼接成一个连续的 bit-stream，
     *   每个值占 bitsPerBlock 位，低位在前 (LSB-first)。
     *   
     *   totalBits = totalBlocks × bitsPerBlock
     *   longCount = ceil(totalBits / 64)
     *   mask = (1 << bitsPerBlock) - 1
     *   
     *   已验证：56544 × 9 = 508896, ceil(508896/64) = 7952 ✓
     */
    function decodeBlockIndices(blockStatesLongs, paletteSize, totalBlocks) {
        // 防护：totalBlocks 必须为合法的正整数
        if (!Number.isInteger(totalBlocks) || totalBlocks <= 0 || totalBlocks >= 0xFFFFFFFF) {
            console.error('无效的 totalBlocks 值：' + totalBlocks);
            throw new Error('方块数量数据异常（' + totalBlocks + '），请检查文件是否损坏');
        }

        if (paletteSize <= 1) {
            return new Array(totalBlocks).fill(0);
        }

        const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(paletteSize)));
        const mask = (1n << BigInt(bitsPerBlock)) - 1n;
        const totalBits = totalBlocks * bitsPerBlock;
        // 检查长整数数量是否足够
        const expectedLongs = Math.ceil(totalBits / 64);
        if (blockStatesLongs.length < expectedLongs) {
            console.warn('BlockStates 长整数数量不足：' + blockStatesLongs.length + ' < ' + expectedLongs);
        }

        const indices = new Array(totalBlocks);

        // 逐位读取：从 bit-stream 中每次取出 bitsPerBlock 位
        for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
            const startBit = blockIndex * bitsPerBlock;
            const startLong = Math.floor(startBit / 64);
            const bitOffset = startBit % 64;

            let idx;
            if (bitOffset + bitsPerBlock <= 64) {
                // 值完全在一个 long 内
                const longVal = (startLong < blockStatesLongs.length)
                    ? blockStatesLongs[startLong]
                    : 0n;
                idx = Number((longVal >> BigInt(bitOffset)) & mask);
            } else {
                // 值跨越两个 long 的边界
                const firstLong = (startLong < blockStatesLongs.length)
                    ? blockStatesLongs[startLong]
                    : 0n;
                const secondLong = (startLong + 1 < blockStatesLongs.length)
                    ? blockStatesLongs[startLong + 1]
                    : 0n;

                const bitsFromFirst = 64 - bitOffset;
                const bitsFromSecond = bitsPerBlock - bitsFromFirst;
                const part1 = (firstLong >> BigInt(bitOffset)) & ((1n << BigInt(bitsFromFirst)) - 1n);
                const part2 = secondLong & ((1n << BigInt(bitsFromSecond)) - 1n);
                idx = Number(part1 | (part2 << BigInt(bitsFromFirst)));
            }

            // 防护：如果 idx 超出调色板范围，设为 0 (air)
            indices[blockIndex] = (idx >= 0 && idx < paletteSize) ? idx : 0;
        }

        return indices;
    }

    /**
     * 将调色板条目格式化为显示字符串
     * 例如 { Name: 'minecraft:hopper', Properties: { facing: 'west', enabled: 'true' } }
     *   → "hopper"  属性列 → "facing=west, enabled=true"
     */
    function formatBlockName(rawName) {
        // 去掉 minecraft: 前缀
        if (rawName.startsWith('minecraft:')) {
            return rawName.substring(10);
        }
        return rawName;
    }

    function formatProperties(properties) {
        if (!properties || Object.keys(properties).length === 0) {
            return '';
        }
        return Object.entries(properties)
            .map(([k, v]) => k + '=' + v)
            .join(', ');
    }

    // ==================== 文件处理 ====================
    async function handleFile(file) {
        if (!file.name.endsWith('.litematic')) {
            alert('请选择 .litematic 格式的文件');
            return;
        }

        showProgress(0, '正在读取文件...');
        hidePreview();
        infoSection.classList.add('hidden');

        try {
            const arrayBuffer = await file.arrayBuffer();
            showProgress(10, '正在解压 GZip...');

            const decompressed = await gunzip(arrayBuffer);
            showProgress(30, '正在解析 NBT 结构...');

            const reader = new NBTReader(decompressed);
            const root = reader.readRoot();
            showProgress(50, '正在提取方块数据...');

            // 获取 Regions
            const regions = root.Regions || {};
            const regionName = Object.keys(regions)[0];
            if (!regionName) {
                throw new Error('未找到任何区域 (Region)');
            }
            const region = regions[regionName];

            const size = region.Size || { x: 0, y: 0, z: 0 };
            // 防护：NBT TAG_Int 是有符号 32 位，但尺寸值不应为负
            // 若出现负值，可能是坐标/偏移量误存，取绝对值作为实际尺寸
            let sx = size.x;
            let sy = size.y;
            let sz = size.z;
            console.log('原始 Size 值:', { sx, sy, sz });
            // NBT TAG_Int 为有符号 32 位整数，尺寸不应为负值
            // 若出现负值，可能是坐标/偏移量误存，取绝对值作为实际尺寸
            if (sx < 0) { sx = Math.abs(sx); console.warn('Size.x 为负值，已取绝对值还原:', sx); }
            if (sy < 0) { sy = Math.abs(sy); console.warn('Size.y 为负值，已取绝对值还原:', sy); }
            if (sz < 0) { sz = Math.abs(sz); console.warn('Size.z 为负值，已取绝对值还原:', sz); }
            // 使用 BigInt 进行乘法，避免中间溢出（虽然 JS Number 有 53 位精度，但保守起见）
            const totalBlocks = Number(BigInt(Math.floor(sx)) * BigInt(Math.floor(sy)) * BigInt(Math.floor(sz)));
            console.log('计算 totalBlocks:', sx, '×', sy, '×', sz, '=', totalBlocks);
            // 二次验证
            if (!Number.isInteger(totalBlocks) || totalBlocks <= 0 || totalBlocks >= 0x1FFFFFFFFFFFFF) {
                console.error('totalBlocks 异常:', totalBlocks, '原始 Size:', size);
                throw new Error('方块数量数据异常（' + totalBlocks + '），原始尺寸：' + sx + '×' + sy + '×' + sz + '，请检查文件是否损坏');
            }

            // 获取调色板
            const palette = region.BlockStatePalette || [];
            const paletteSize = palette.length;

            // 获取 BlockStates
            const blockStatesLongs = region.BlockStates || [];

            // 显示文件信息
            showFileInfo({
                fileName: file.name,
                fileSize: formatFileSize(file.size),
                version: root.Version || '?',
                dataVersion: root.MinecraftDataVersion || '?',
                regionName: regionName,
                dimensions: sx + ' × ' + sy + ' × ' + sz,
                totalBlocks: totalBlocks.toLocaleString(),
                paletteSize: paletteSize,
                entities: (region.Entities || []).length,
                tileEntities: (region.TileEntities || []).length,
            });

            showProgress(70, '正在解码方块数据...');

            // 解码方块
            console.log('准备解码：totalBlocks=' + totalBlocks + ', paletteSize=' + paletteSize + ', blockStatesLongs.length=' + blockStatesLongs.length);
            const indices = decodeBlockIndices(blockStatesLongs, paletteSize, totalBlocks);
            showProgress(85, '正在统计方块...');

            // 统计方块（排除空气）
            // 关键修复：按基础方块名称合并，忽略 block state 属性
            // 例如 hopper(facing=west) 和 hopper(facing=east) 合并为同一个 hopper 条目
            // 这样从材料收集角度避免了同种材料的多余重复条目
            const blockCounts = new Map();
            for (let i = 0; i < indices.length; i++) {
                const idx = indices[i];
                const entry = palette[idx];
                if (!entry) continue;

                const rawName = entry.Name || '';
                // 跳过空气
                if (rawName === 'minecraft:air') continue;

                const displayName = formatBlockName(rawName);
                // 只用基础名称作为键（忽略属性），避免同种材料重复
                blockCounts.set(displayName, (blockCounts.get(displayName) || 0) + 1);
            }

            showProgress(95, '正在渲染表格...');

            // 按数量降序排列
            // key 现在是纯方块名称（不含 props），保持 [name, '', count] 三元组格式
            const sorted = Array.from(blockCounts.entries())
                .map(([name, count]) => [name, '', count])
                .sort((a, b) => b[2] - a[2]);

            // 缓存数据
            currentData = {
                info: {
                    fileName: file.name,
                    dimensions: sx + '×' + sy + '×' + sz,
                    totalBlocks: totalBlocks,
                    nonAirBlocks: sorted.reduce((sum, r) => sum + r[2], 0),
                    uniqueTypes: sorted.length,
                },
                blocks: sorted,
            };

            // 渲染表格
            renderTable(sorted);

            showProgress(100, '完成');
            setTimeout(() => {
                progressSection.classList.add('hidden');
                previewSection.classList.remove('hidden');
            }, 400);

        } catch (err) {
            progressSection.classList.add('hidden');
            alert('解析失败：' + err.message);
            console.error(err);
        }
    }

    // ==================== UI 渲染 ====================
    function showFileInfo(info) {
        const items = [
            { label: '文件名', value: info.fileName },
            { label: '文件大小', value: info.fileSize },
            { label: '投影版本', value: info.version },
            { label: '数据版本', value: info.dataVersion },
            { label: '区域名称', value: info.regionName },
            { label: '尺寸 (X×Y×Z)', value: info.dimensions },
            { label: '方块总数', value: info.totalBlocks },
            { label: '方块种类', value: info.paletteSize },
            { label: '实体数', value: info.entities },
            { label: '方块实体数', value: info.tileEntities },
        ];

        infoGrid.innerHTML = items
            .map(
                (item) =>
                    `<div class="info-item"><span class="label">${item.label}</span><span class="value">${item.value}</span></div>`
            )
            .join('');
        infoSection.classList.remove('hidden');
    }

    function renderTable(rows) {
        let html = '';
        let totalGroups = 0;
        let totalBoxes = 0;

        rows.forEach(([name, props, count], index) => {
            const groups = Math.ceil(count / 64);
            const boxes = Math.ceil(groups / 27);
            totalGroups += groups;
            totalBoxes += boxes;
            const chineseName = translateBlockName(name);
            html += `
                <tr>
                    <td class="col-idx">${index + 1}</td>
                    <td class="col-en-name">${escapeHTML(name)}</td>
                    <td class="col-cn-name">${escapeHTML(chineseName)}</td>
                    <td class="col-count">${count.toLocaleString()}</td>
                    <td class="col-groups">${groups.toLocaleString()}</td>
                    <td class="col-boxes">${boxes.toLocaleString()}</td>
                </tr>`;
        });

        // 合计行
        const total = rows.reduce((sum, r) => sum + r[2], 0);
        html += `
            <tr class="summary-row">
                <td class="col-idx"></td>
                <td class="col-en-name"></td>
                <td class="col-cn-name">合计 ${rows.length} 种方块</td>
                <td class="col-count">${total.toLocaleString()}</td>
                <td class="col-groups">${totalGroups.toLocaleString()}</td>
                <td class="col-boxes">${totalBoxes.toLocaleString()}</td>
            </tr>`;

        tableBody.innerHTML = html;
    }

    function hidePreview() {
        previewSection.classList.add('hidden');
        tableBody.innerHTML = '';
        currentData = null;
    }

    function showProgress(percent, text) {
        progressSection.classList.remove('hidden');
        progressBar.style.width = percent + '%';
        progressText.textContent = text;
    }

    // ==================== CSV 导出 ====================
    function exportCSV() {
        if (!currentData || !currentData.blocks.length) {
            alert('没有可导出的数据，请先加载文件');
            return;
        }

        const info = currentData.info;
        let csv = '\uFEFF'; // BOM for Excel UTF-8
        csv += '序号,英文名称,中文名称,总数,组数,盒数\n';

        let totalGroups = 0;
        let totalBoxes = 0;

        currentData.blocks.forEach(([name, props, count], index) => {
            const groups = Math.ceil(count / 64);
            const boxes = Math.ceil(groups / 27);
            totalGroups += groups;
            totalBoxes += boxes;
            const chineseName = translateBlockName(name);
            const escapedEnName = csvEscape(name);
            const escapedCnName = csvEscape(chineseName);
            csv += `${index + 1},${escapedEnName},${escapedCnName},${count},${groups},${boxes}\n`;
        });

        // 合计行
        csv += `,,,合计 ${currentData.blocks.length} 种方块,${info.nonAirBlocks},${totalGroups},${totalBoxes}\n`;

        // 元信息
        csv += '\n';
        csv += `文件,${info.fileName}\n`;
        csv += `尺寸,${info.dimensions}\n`;
        csv += `方块总数,${info.totalBlocks}\n`;
        csv += `非空气方块,${info.nonAirBlocks}\n`;
        csv += `方块种类,${info.uniqueTypes}\n`;

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (info.fileName || 'output').replace(/\.litematic$/i, '') + '_材料表.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ==================== XLSX 导出 ====================
    function exportXLSX() {
        if (!currentData || !currentData.blocks.length) {
            alert('没有可导出的数据，请先加载文件');
            return;
        }

        const info = currentData.info;

        // 构建数据数组
        const headerRow = ['序号', '英文名称', '中文名称', '总数', '组数', '盒数'];

        let totalGroups = 0;
        let totalBoxes = 0;

        const dataRows = currentData.blocks.map(([name, props, count], index) => {
            const groups = Math.ceil(count / 64);
            const boxes = Math.ceil(groups / 27);
            totalGroups += groups;
            totalBoxes += boxes;
            const chineseName = translateBlockName(name);
            return [index + 1, name, chineseName, count, groups, boxes];
        });

        // 合计行
        const summaryRow = ['', '', '合计 ' + currentData.blocks.length + ' 种方块', info.nonAirBlocks, totalGroups, totalBoxes];

        // 元信息（空白分隔行）
        const metaRows = [
            ['文件信息', ''],
            ['文件', info.fileName],
            ['尺寸', info.dimensions],
            ['方块总数', info.totalBlocks],
            ['非空气方块', info.nonAirBlocks],
            ['方块种类', info.uniqueTypes],
        ];

        const allRows = [headerRow, ...dataRows, summaryRow, [], ...metaRows];

        const ws = XLSX.utils.aoa_to_sheet(allRows);

        // 设置列宽
        ws['!cols'] = [
            { wch: 8 },   // 序号
            { wch: 20 },  // 英文名称
            { wch: 22 },  // 中文名称
            { wch: 10 },  // 总数
            { wch: 8 },   // 组数
            { wch: 8 },   // 盒数
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '材料表');

        const filename = (info.fileName || 'output').replace(/\.litematic$/i, '') + '_材料表.xlsx';
        XLSX.writeFile(wb, filename);
    }

    function csvEscape(str) {
        if (!str) return '';
        // 如果包含逗号、引号或换行，需要用引号包裹
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function clearData() {
        currentData = null;
        tableBody.innerHTML = '';
        infoGrid.innerHTML = '';
        infoSection.classList.add('hidden');
        previewSection.classList.add('hidden');
        progressSection.classList.add('hidden');
    }

    // ==================== 事件绑定 ====================
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            handleFile(file);
        }
        fileInput.value = '';
    });

    // 拖拽支持
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('drag-over');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) {
            handleFile(file);
        }
    });

    btnExportCsv.addEventListener('click', exportCSV);
    btnExportXlsx.addEventListener('click', exportXLSX);
    btnClear.addEventListener('click', clearData);
})();