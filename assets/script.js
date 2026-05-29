/**
 * Minecraft 材料表工具集 — 合并脚本
 * 
 * Tab 1: 投影转换 (Litematic → CSV)
 * Tab 2: 材料分配 (CSV 导入 + 进度跟踪 + 材料分组)
 * 
 * 核心交互：转换完成后可一键将数据发送到材料分配页面
 */

(function () {
    'use strict';

    // ==================== Tab 切换逻辑 ====================
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    function switchTab(tabName) {
        tabButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        tabPanels.forEach(panel => {
            panel.classList.toggle('active', panel.id === 'panel-' + tabName);
        });
    }

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // --- 触摸滑动切换标签页 (移动端手势) ---
    (function initSwipeGesture() {
        const tabNames = Array.from(tabButtons).map(b => b.dataset.tab);
        let startX = 0;
        let startY = 0;
        let tracking = false;

        document.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) { tracking = false; return; }
            // 不拦截可滚动区域内的滑动（表格横向滚动、过滤标签滚动等）
            if (e.target.closest('.table-wrapper, .filter-group, [style*="overflow"]')) {
                tracking = false;
                return;
            }
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!tracking) return;
            const deltaY = Math.abs(e.touches[0].clientY - startY);
            const deltaX = Math.abs(e.touches[0].clientX - startX);
            // 一旦发现是垂直滚动就放弃本次手势
            if (deltaY > deltaX && deltaY > 10) {
                tracking = false;
            }
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;

            // 忽略垂直滑动（滚动页面）和过小的水平滑动
            if (Math.abs(deltaY) > Math.abs(deltaX) || Math.abs(deltaX) < 60) return;

            const currentTab = document.querySelector('.tab-btn.active');
            if (!currentTab) return;
            const currentIdx = tabNames.indexOf(currentTab.dataset.tab);
            if (currentIdx === -1) return;

            let targetIdx;
            if (deltaX < 0) {
                // 左滑 → 下一个标签
                targetIdx = Math.min(currentIdx + 1, tabNames.length - 1);
            } else {
                // 右滑 → 上一个标签
                targetIdx = Math.max(currentIdx - 1, 0);
            }

            if (targetIdx !== currentIdx) {
                switchTab(tabNames[targetIdx]);
            }
        }, { passive: true });
    })();

    // ==================== Toast ====================
    function showToast(message) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast-message';
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    // ==================== 共享工具函数 ====================
    function escapeHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function csvEscape(str) {
        if (!str) return '';
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function splitCSVLine(line) {
        const cols = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') {
                        current += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current += ch;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                } else if (ch === ',') {
                    cols.push(current);
                    current = '';
                } else {
                    current += ch;
                }
            }
        }
        cols.push(current);
        return cols;
    }

    // ==================================================================
    //  Module A: 投影转换 (原 parser.js)
    // ==================================================================

    // --- DOM 引用 (Convert) ---
    const convertContainer = document.querySelector('#panel-convert .container');
    const convertUploadArea = document.getElementById('upload-area-litematic');
    const convertFileInput = document.getElementById('file-input-litematic');
    const infoSection = document.getElementById('info-section');
    const infoGrid = document.getElementById('info-grid');
    const convertProgressSection = document.getElementById('convert-progress-section');
    const convertProgressBar = document.getElementById('convert-progress-bar');
    const convertProgressText = document.getElementById('convert-progress-text');
    const previewSection = document.getElementById('preview-section');
    const convertTableBody = document.getElementById('convert-table-body');
    const btnExportCsv = document.getElementById('btn-export-csv');
    const btnClearConvert = document.getElementById('btn-clear-convert');
    const btnSendToAssign = document.getElementById('btn-send-to-assign');

    /** 转换结果缓存 */
    let currentConvertData = null;

    // --- GZip 解压 ---
    async function gunzip(arrayBuffer) {
        const ds = new DecompressionStream('gzip');
        const readable = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(arrayBuffer));
                controller.close();
            }
        });
        const decompressedStream = readable.pipeThrough(ds);
        return new Response(decompressedStream).arrayBuffer();
    }

    // --- NBT 解析器 ---
    class NBTReader {
        constructor(buffer) {
            this.data = new DataView(buffer);
            this.pos = 0;
        }

        readRoot() {
            const tag = this.readByte();
            if (tag !== 10) throw new Error('NBT 根必须是 TAG_Compound，实际 tag=' + tag);
            this.readUTF();
            return this.readCompound();
        }

        readByte() { const v = this.data.getUint8(this.pos); this.pos += 1; return v; }
        readShort() { const v = this.data.getInt16(this.pos, false); this.pos += 2; return v; }
        readInt() { const v = this.data.getInt32(this.pos, false); this.pos += 4; return v; }
        readLong() { const v = this.data.getBigInt64(this.pos, false); this.pos += 8; return v; }
        readFloat() { const v = this.data.getFloat32(this.pos, false); this.pos += 4; return v; }
        readDouble() { const v = this.data.getFloat64(this.pos, false); this.pos += 8; return v; }

        readUTF() {
            const length = this.readShort();
            const bytes = new Uint8Array(this.data.buffer, this.pos, length);
            this.pos += length;
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
                case 7: {
                    const length = this.readInt();
                    const arr = new Uint8Array(this.data.buffer, this.pos, length);
                    this.pos += length;
                    return arr;
                }
                case 8:  return this.readUTF();
                case 9: {
                    const itemType = this.readByte();
                    const length = this.readInt();
                    const arr = [];
                    for (let i = 0; i < length; i++) arr.push(this.readValue(itemType));
                    return arr;
                }
                case 10: return this.readCompound();
                case 11: {
                    const length = this.readInt();
                    const arr = [];
                    for (let i = 0; i < length; i++) arr.push(this.readInt());
                    return arr;
                }
                case 12: {
                    const length = this.readInt();
                    const arr = [];
                    for (let i = 0; i < length; i++) arr.push(this.readLong());
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

    // --- 方块解码 ---
    function decodeBlockIndices(blockStatesLongs, paletteSize, totalBlocks) {
        if (!Number.isInteger(totalBlocks) || totalBlocks <= 0 || totalBlocks >= 0xFFFFFFFF) {
            throw new Error('方块数量数据异常（' + totalBlocks + '），请检查文件是否损坏');
        }
        if (paletteSize <= 1) return new Array(totalBlocks).fill(0);

        const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(paletteSize)));
        const mask = (1n << BigInt(bitsPerBlock)) - 1n;
        const indices = new Array(totalBlocks);

        for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
            const startBit = blockIndex * bitsPerBlock;
            const startLong = Math.floor(startBit / 64);
            const bitOffset = startBit % 64;

            let idx;
            if (bitOffset + bitsPerBlock <= 64) {
                const longVal = (startLong < blockStatesLongs.length) ? blockStatesLongs[startLong] : 0n;
                idx = Number((longVal >> BigInt(bitOffset)) & mask);
            } else {
                const firstLong = (startLong < blockStatesLongs.length) ? blockStatesLongs[startLong] : 0n;
                const secondLong = (startLong + 1 < blockStatesLongs.length) ? blockStatesLongs[startLong + 1] : 0n;
                const bitsFromFirst = 64 - bitOffset;
                const bitsFromSecond = bitsPerBlock - bitsFromFirst;
                const part1 = (firstLong >> BigInt(bitOffset)) & ((1n << BigInt(bitsFromFirst)) - 1n);
                const part2 = secondLong & ((1n << BigInt(bitsFromSecond)) - 1n);
                idx = Number(part1 | (part2 << BigInt(bitsFromFirst)));
            }
            indices[blockIndex] = (idx >= 0 && idx < paletteSize) ? idx : 0;
        }
        return indices;
    }

    function formatBlockName(rawName) {
        if (rawName.startsWith('minecraft:')) return rawName.substring(10);
        return rawName;
    }

    // --- 文件处理 (Convert) ---
    async function handleConvertFile(file) {
        if (!file.name.endsWith('.litematic')) {
            showToast('请选择 .litematic 格式的文件');
            return;
        }

        showConvertProgress(0, '正在读取文件...');
        hideConvertPreview();

        try {
            const arrayBuffer = await file.arrayBuffer();
            showConvertProgress(10, '正在解压 GZip...');

            const decompressed = await gunzip(arrayBuffer);
            showConvertProgress(30, '正在解析 NBT 结构...');

            const reader = new NBTReader(decompressed);
            const root = reader.readRoot();
            showConvertProgress(50, '正在提取方块数据...');

            const regions = root.Regions || {};
            const regionName = Object.keys(regions)[0];
            if (!regionName) throw new Error('未找到任何区域 (Region)');
            const region = regions[regionName];

            const size = region.Size || { x: 0, y: 0, z: 0 };
            let sx = size.x, sy = size.y, sz = size.z;
            if (sx < 0) { sx = Math.abs(sx); }
            if (sy < 0) { sy = Math.abs(sy); }
            if (sz < 0) { sz = Math.abs(sz); }
            const totalBlocks = Number(BigInt(Math.floor(sx)) * BigInt(Math.floor(sy)) * BigInt(Math.floor(sz)));

            const palette = region.BlockStatePalette || [];
            const paletteSize = palette.length;
            const blockStatesLongs = region.BlockStates || [];

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

            showConvertProgress(70, '正在解码方块数据...');
            const indices = decodeBlockIndices(blockStatesLongs, paletteSize, totalBlocks);
            showConvertProgress(85, '正在统计方块...');

            const blockCounts = new Map();
            for (let i = 0; i < indices.length; i++) {
                const idx = indices[i];
                const entry = palette[idx];
                if (!entry) continue;
                const rawName = entry.Name || '';
                if (rawName === 'minecraft:air') continue;
                const displayName = formatBlockName(rawName);
                blockCounts.set(displayName, (blockCounts.get(displayName) || 0) + 1);
            }

            showConvertProgress(95, '正在渲染表格...');

            const sorted = Array.from(blockCounts.entries())
                .map(([name, count]) => [name, '', count])
                .sort((a, b) => b[2] - a[2]);

            const unmatchedNames = [];
            sorted.forEach(([name]) => {
                const chineseName = (typeof translateBlockName === 'function') ? translateBlockName(name) : '';
                if (!chineseName) {
                    unmatchedNames.push(name);
                    console.error('[翻译缺失] 英文名称 "' + name + '" 没有对应的中文翻译');
                }
            });

            currentConvertData = {
                info: {
                    fileName: file.name,
                    dimensions: sx + '×' + sy + '×' + sz,
                    totalBlocks: totalBlocks,
                    nonAirBlocks: sorted.reduce((sum, r) => sum + r[2], 0),
                    uniqueTypes: sorted.length,
                },
                blocks: sorted,
                unmatchedNames: unmatchedNames,
            };

            renderConvertTable(sorted);
            showTranslationWarning(unmatchedNames);

            showConvertProgress(100, '完成');
            setTimeout(() => {
                convertProgressSection.classList.add('hidden');
                previewSection.classList.remove('hidden');
                // 标记有结果，折叠上传区
                if (convertContainer) convertContainer.classList.add('has-results');
            }, 400);
        } catch (err) {
            convertProgressSection.classList.add('hidden');
            hideTranslationWarning();
            showToast('解析失败：' + err.message);
            console.error(err);
        }
    }

    function showConvertProgress(percent, text) {
        convertProgressSection.classList.remove('hidden');
        convertProgressBar.style.width = percent + '%';
        convertProgressText.textContent = text;
    }

    function hideConvertPreview() {
        previewSection.classList.add('hidden');
        convertTableBody.innerHTML = '';
        infoSection.classList.add('hidden');
        currentConvertData = null;
        hideTranslationWarning();
        // 恢复上传区
        if (convertContainer) convertContainer.classList.remove('has-results');
    }

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
            .map(item => `<div class="info-item"><span class="label">${item.label}</span><span class="value">${item.value}</span></div>`)
            .join('');
        infoSection.classList.remove('hidden');
    }

    function renderConvertTable(rows) {
        let html = '';
        let totalGroups = 0;
        let totalBoxes = 0;
        rows.forEach(([name, props, count], index) => {
            const groups = Math.ceil(count / 64);
            const boxes = Math.ceil(groups / 27);
            totalGroups += groups;
            totalBoxes += boxes;
            const chineseName = (typeof translateBlockName === 'function') ? translateBlockName(name) : name;
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
        convertTableBody.innerHTML = html;
    }

    // --- 翻译警告 ---
    function showTranslationWarning(unmatchedNames) {
        const warningSection = document.getElementById('translation-warning');
        const warningList = document.getElementById('warning-list');
        const warningCount = document.getElementById('warning-count');
        const btnDownloadLog = document.getElementById('btn-download-log');

        if (!unmatchedNames || unmatchedNames.length === 0) {
            hideTranslationWarning();
            return;
        }
        warningCount.textContent = unmatchedNames.length;
        const warningCountText = document.getElementById('warning-count-text');
        if (warningCountText) warningCountText.textContent = unmatchedNames.length;
        warningList.textContent = unmatchedNames.join('、');
        warningSection.classList.remove('hidden');

        const newBtn = btnDownloadLog.cloneNode(true);
        btnDownloadLog.parentNode.replaceChild(newBtn, btnDownloadLog);
        newBtn.addEventListener('click', () => downloadTranslationLog(unmatchedNames));
    }

    function hideTranslationWarning() {
        const ws = document.getElementById('translation-warning');
        if (ws) ws.classList.add('hidden');
    }

    function downloadTranslationLog(unmatchedNames) {
        const now = new Date();
        const ts = now.getFullYear() +
            ('0' + (now.getMonth() + 1)).slice(-2) +
            ('0' + now.getDate()).slice(-2) + '_' +
            ('0' + now.getHours()).slice(-2) +
            ('0' + now.getMinutes()).slice(-2) +
            ('0' + now.getSeconds()).slice(-2);
        const info = currentConvertData ? currentConvertData.info : { fileName: 'unknown' };
        const baseName = (info.fileName || 'output').replace(/\.litematic$/i, '');

        let log = '\uFEFF';
        log += '================================================================\n';
        log += '  Litematic 材料表转换器 - 翻译缺失日志\n';
        log += '================================================================\n';
        log += '生成时间: ' + now.toLocaleString('zh-CN') + '\n';
        log += '源文件:   ' + (info.fileName || '未知') + '\n';
        log += '----------------------------------------------------------------\n';
        log += '以下英文名称在翻译映射表中未找到对应的中文翻译：\n';
        log += '----------------------------------------------------------------\n';
        unmatchedNames.forEach((name, i) => { log += (i + 1) + '. ' + name + '\n'; });
        log += '----------------------------------------------------------------\n';
        log += '共计 ' + unmatchedNames.length + ' 个方块缺少中文翻译\n';
        log += '================================================================\n';

        const blob = new Blob([log], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = baseName + '_翻译缺失日志_' + ts + '.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // --- CSV 导出 ---
    function exportCSV() {
        if (!currentConvertData || !currentConvertData.blocks.length) {
            showToast('没有可导出的数据，请先加载文件');
            return;
        }
        const info = currentConvertData.info;
        let csv = '\uFEFF';
        csv += '序号,英文名称,中文名称,总数,组数,盒数\n';
        let totalGroups = 0;
        let totalBoxes = 0;

        currentConvertData.blocks.forEach(([name, props, count], index) => {
            const groups = Math.ceil(count / 64);
            const boxes = Math.ceil(groups / 27);
            totalGroups += groups;
            totalBoxes += boxes;
            const chineseName = (typeof translateBlockName === 'function') ? translateBlockName(name) : name;
            csv += `${index + 1},${csvEscape(name)},${csvEscape(chineseName)},${count},${groups},${boxes}\n`;
        });

        csv += `,,,合计 ${currentConvertData.blocks.length} 种方块,${info.nonAirBlocks},${totalGroups},${totalBoxes}\n`;
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

    function clearConvertData() {
        currentConvertData = null;
        convertTableBody.innerHTML = '';
        infoGrid.innerHTML = '';
        infoSection.classList.add('hidden');
        previewSection.classList.add('hidden');
        convertProgressSection.classList.add('hidden');
        hideTranslationWarning();
        // 恢复上传区
        if (convertContainer) convertContainer.classList.remove('has-results');
    }

    // --- Convert 事件绑定 ---
    // 注：不使用 JS click 打开文件选择器，HTML <label for="..."> 已处理手机端兼容性
    convertFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleConvertFile(file);
        // 延迟清空，避免手机端 iOS Safari 因同步清空 value 而重新弹出文件选择器
        setTimeout(() => { convertFileInput.value = ''; }, 200);
    });
    convertUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); convertUploadArea.classList.add('drag-over'); });
    convertUploadArea.addEventListener('dragleave', () => convertUploadArea.classList.remove('drag-over'));
    convertUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        convertUploadArea.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleConvertFile(file);
    });
    btnExportCsv.addEventListener('click', exportCSV);
    btnClearConvert.addEventListener('click', clearConvertData);

    // ==================================================================
    //  Module B: 材料分配 (原 script.js)
    // ==================================================================

    // --- DOM 引用 (Assign) ---
    const assignUploadArea = document.getElementById('upload-area-csv');
    const assignUploadSection = document.getElementById('assign-upload-section');
    const assignFileInput = document.getElementById('file-input-csv');
    const assignToolbar = document.getElementById('assign-toolbar');
    const searchInput = document.getElementById('search-input');
    const filterUnassigned = document.getElementById('filter-unassigned');
    const filterAssigned = document.getElementById('filter-assigned');
    const statsSummary = document.getElementById('stats-summary');
    const btnResetAll = document.getElementById('btn-reset-all');
    const btnExportXlsx = document.getElementById('btn-export-xlsx');
    const btnToggleAll = document.getElementById('btn-toggle-all');
    const assignTableSection = document.getElementById('assign-table-section');
    const assignTableBody = document.getElementById('assign-table-body');
    const assignEmptyState = document.getElementById('assign-empty-state');

    /** @type {Array} 材料数据 */
    let materials = [];
    let sourceFileName = 'materials';

    // --- 材料分组 ---
    const MATERIAL_SUFFIXES = [
        '染色玻璃板', '铁活板门', '玻璃板', '活板门', '栅栏门', '栅栏', '压力板', '按钮',
        '台阶', '楼梯', '墙', '门',
        '木板', '原木', '木头', '菌柄', '菌核', '竹块', '竹板', '竹马赛克',
        '树叶', '树苗', '蘑菇方块', '蘑菇', '菌岩', '菌丝', '菌光体',
        '下界疣块', '下界疣', '植株', '茎', '藤蔓', '地衣', '垂根', '树根', '竹笋', '草', '蕨', '花丛', '花簇',
        '珊瑚块', '珊瑚扇', '珊瑚',
        '石砖', '下界砖', '红砖块', '砖块', '砖', '圆石', '石头',
        '黑石', '深板岩', '凝灰岩', '花岗岩', '闪长岩', '安山岩',
        '砂岩', '红砂岩', '石英', '混凝土粉末', '混凝土', '陶瓦', '带釉陶瓦',
        '矿石', '原矿', '方解石', '滴水石锥', '滴水石块', '滴水石',
        '玄武岩', '黑曜石', '紫水晶母岩', '紫水晶簇', '紫水晶块', '紫水晶', '紫晶芽',
        '树脂砖', '树脂块', '树脂簇', '泥砖', '泥坯', '泥巴',
        '染色玻璃', '玻璃',
        '块', '陷阱箱', '潜影盒', '箱子', '木桶', '书架',
        '粘性活塞', '活塞', '发射器', '投掷器', '侦测器',
        '漏斗矿车', '箱子矿车', '运输矿车', 'TNT矿车', '漏斗',
        '比较器', '中继器', '红石火把', '红石粉', '红石块', '红石灯',
        '标靶', '避雷针', '绊线钩',
        '探测铁轨', '充能铁轨', '激活铁轨', '铁轨',
        '铜傀儡雕像', '铜雕像', '雕像', '铜栏杆', '铁栏杆', '栏杆',
        '铜锁链', '铁锁链', '锁链', '铜格栅', '格栅',
        '铜灯', '铜门', '铜活板门', '铜箱子', '铜灯笼', '铜火把',
        '高炉', '烟熏炉', '熔炉', '酿造台', '制图台', '制箭台', '锻造台', '织布机', '切石机',
        '讲台', '附魔台', '铁砧', '堆肥桶', '炼药锅', '砂轮',
        '悬挂告示牌', '告示牌', '营火', '灵魂营火',
        '画', '物品展示框', '盔甲架', '花盆', '盆栽', '脚手架', '梯子',
        '蜡烛', '床', '地毯', '旗帜',
        '灵魂火把', '灵魂灯笼', '火把', '灯笼', '海晶灯', '蛙明灯', '荧石', '南瓜灯',
        '阳光探测器', '头颅', '试炼刷怪笼', '刷怪笼', '宝库', '重锤核心', '合成器',
        '信标', '唱片机', '重生锚', '磁石', '潮涌核心',
        '末地烛', '饰纹陶罐', '龙蛋', '紫颂花', '紫颂植株', '传送门框架',
        '竖纹', '錾制',
        '蛋糕', '蜂巢', '蜂箱', '蜘蛛网', '海绵', '干海带块',
        '粘液块', '蜂蜜块', '蜜脾块', '干草块', '骨块',
        '吱吱作响之心', '干燥恶魂',
    ];

    const MATERIAL_PREFIXES = [
        '淡灰色', '淡蓝色', '黄绿色', '品红色',
        '白色', '橙色', '品红', '淡蓝', '黄色', '黄绿',
        '粉色', '灰色', '淡灰', '青色', '紫色', '蓝色',
        '棕色', '绿色', '红色', '黑色',
        '去皮深色', '去皮白桦', '去皮云杉', '去皮丛林',
        '去皮金合欢', '去皮深板岩', '去皮绯红', '去皮诡异', '去皮',
        '深色橡木', '白桦木', '云杉木', '丛林木', '金合欢木',
        '苍白橡木', '红树木', '樱花木', '竹',
        '深板岩', '绯红', '诡异',
        '橡木', '白桦', '云杉', '丛林', '金合欢', '深色', '苍白', '红树', '樱花',
        '錾制深板岩', '磨制黑石', '磨制深板岩', '裂纹深板岩', '裂纹下界砖',
        '平滑石头', '平滑砂岩', '平滑红砂岩', '平滑石英',
        '錾制石砖', '錾制砂岩', '錾制红砂岩', '錾制下界砖',
        '錾制石英', '錾制凝灰岩', '錾制树脂砖', '錾制铜块',
        '磨制', '錾制', '裂纹', '苔石砖', '苔石', '平滑', '强化',
        '斑驳的涂蜡', '锈蚀的涂蜡', '氧化的涂蜡', '斑驳的', '锈蚀的', '氧化的', '涂蜡',
        '充能', '激活', '失活', '触发',
        '暗海晶', '海晶石', '海晶', '紫珀', '末地', '下界砖', '下界', '红砖',
        '红砂岩', '红沙', '砂岩', '沙石',
        '粗铁', '粗金', '粗铜', '铁', '金', '钻石', '下界合金',
        '灵魂营火', '灵魂灯笼', '灵魂火把', '锁链', '灯笼', '营火',
        '阳光', '月光', '黏性', '黏液', '红石', '铜',
        '失活的', '墙上的', '墙上', '悬挂式', '悬挂', '盛开的',
        '装有', '插上', '被虫蚀的', '开裂的', '损坏的',
        '赭黄', '珠光', '翠绿', '小型', '中型', '大型', '不祥',
    ];

    function extractBaseType(cnName) {
        if (!cnName) return '';
        const sortedSuffixes = [...MATERIAL_SUFFIXES].sort((a, b) => b.length - a.length);
        for (const suffix of sortedSuffixes) {
            if (cnName.endsWith(suffix) && cnName.length > suffix.length) return suffix;
        }
        const sortedPrefixes = [...MATERIAL_PREFIXES].sort((a, b) => b.length - a.length);
        for (const prefix of sortedPrefixes) {
            if (cnName.startsWith(prefix)) {
                const rest = cnName.slice(prefix.length);
                if (rest.length >= 1) return rest;
            }
        }
        return cnName;
    }

    function assignGroups(mats) {
        const baseTypeMap = new Map();
        for (const m of mats) {
            baseTypeMap.set(m.chineseName, extractBaseType(m.chineseName));
        }
        const groupMap = new Map();
        for (let i = 0; i < mats.length; i++) {
            const bt = baseTypeMap.get(mats[i].chineseName);
            if (!groupMap.has(bt)) groupMap.set(bt, []);
            groupMap.get(bt).push(i);
        }
        let groupNumber = 1;
        for (const [baseType, indices] of groupMap) {
            const gn = groupNumber++;
            for (const idx of indices) {
                mats[idx].groupName = baseType;
                mats[idx].groupNumber = gn;
            }
        }
    }

    // --- CSV 解析 ---
    function parseCSV(text) {
        const rows = [];
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

        let hasEnglishColumn = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const cols = splitCSVLine(trimmed);
            if (cols.length >= 4) {
                if (cols[1] && cols[1].trim() === '英文名称') { hasEnglishColumn = true; }
                break;
            }
        }

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const cols = splitCSVLine(trimmed);
            if (cols.length < 3) continue;

            const seq = cols[0].trim();
            let cnColIdx, countIdx, groupsIdx, boxesIdx;
            if (hasEnglishColumn) {
                cnColIdx = 2; countIdx = 3; groupsIdx = 4; boxesIdx = 5;
            } else {
                cnColIdx = 1; countIdx = 2; groupsIdx = 3; boxesIdx = 4;
            }

            const chineseName = (cols[cnColIdx] || '').trim();
            const countStr = (cols[countIdx] || '').trim();
            const groupsStr = (cols[groupsIdx] || '').trim();
            const boxesStr = (cols[boxesIdx] || '').trim();

            if (seq === '序号') continue;
            if (!seq) continue;
            if (seq.startsWith('合计') || chineseName.startsWith('合计')) continue;
            if (seq === '文件' || seq === '尺寸' || seq === '方块总数' ||
                seq === '非空气方块' || seq === '方块种类') {
                if (chineseName) sourceFileName = chineseName.replace(/\.litematic$/i, '');
                continue;
            }

            const count = parseInt(countStr, 10);
            if (isNaN(count) || count <= 0) continue;
            if (!chineseName) continue;

            const groups = parseInt(groupsStr, 10) || 0;
            const boxes = parseInt(boxesStr, 10) || 0;

            rows.push({
                name: chineseName,
                chineseName: chineseName,
                count: count,
                groups: groups,
                boxes: boxes,
                done: false,
                assignee: '',
            });
        }
        return mergeDuplicateMaterials(rows);
    }

    function mergeDuplicateMaterials(rows) {
        const map = new Map();
        for (const row of rows) {
            const cnKey = (row.chineseName || '').toLowerCase().trim();
            if (!cnKey) continue;
            if (map.has(cnKey)) {
                map.get(cnKey).count += row.count;
            } else {
                map.set(cnKey, {
                    name: row.chineseName,
                    chineseName: row.chineseName,
                    count: row.count,
                    done: row.done,
                    assignee: row.assignee,
                });
            }
        }
        const merged = Array.from(map.values());
        for (const item of merged) {
            item.groups = Math.ceil(item.count / 64);
            item.boxes = Math.ceil(item.groups / 27);
        }
        return merged;
    }

    // --- 文件 / 数据加载 ---
    async function handleAssignFile(file) {
        if (!file.name.endsWith('.csv')) {
            showToast('请选择 .csv 格式的文件');
            return;
        }
        try {
            const text = await file.text();
            const parsed = parseCSV(text);
            if (parsed.length === 0) {
                showToast('CSV 文件中未找到有效的材料数据');
                return;
            }
            sourceFileName = file.name.replace(/\.csv$/i, '').replace(/_材料表$/, '');
            materials = parsed;
            assignGroups(materials);
            showAssignMainUI();
            renderAssignAll();
        } catch (err) {
            showToast('CSV 解析失败：' + err.message);
            console.error(err);
        }
    }

    /** 从转换页面接收数据 */
    function loadAssignFromConvert(convertData) {
        if (!convertData || !convertData.blocks.length) return;

        const blocks = convertData.blocks;
        materials = blocks.map(([name, props, count]) => {
            const chineseName = (typeof translateBlockName === 'function') ? translateBlockName(name) : name;
            return {
                name: chineseName,
                chineseName: chineseName || name,
                count: count,
                groups: Math.ceil(count / 64),
                boxes: Math.ceil(Math.ceil(count / 64) / 27),
                done: false,
                assignee: '',
            };
        });

        // 去重合并
        materials = mergeDuplicateMaterials(materials);

        sourceFileName = (convertData.info.fileName || 'output').replace(/\.litematic$/i, '');
        assignGroups(materials);
        showAssignMainUI();
        renderAssignAll();
        showToast('已接收 ' + materials.length + ' 种材料，请到材料分配标签页查看');
    }

    // --- UI 切换 (Assign) ---
    function showAssignMainUI() {
        assignUploadSection.classList.add('hidden');
        assignToolbar.classList.remove('hidden');
        assignTableSection.classList.remove('hidden');
    }

    function showAssignUploadUI() {
        assignUploadSection.classList.remove('hidden');
        assignToolbar.classList.add('hidden');
        assignTableSection.classList.add('hidden');
    }

    // --- 渲染 (Assign) ---
    function getFilteredMaterials() {
        const searchTerm = searchInput.value.trim().toLowerCase();
        const showUnassigned = filterUnassigned.checked;
        const showAssigned = filterAssigned.checked;

        return materials.filter((m) => {
            if (searchTerm) {
                const cnName = m.chineseName || '';
                const groupStr = '材料组' + m.groupNumber;
                if (!cnName.toLowerCase().includes(searchTerm) &&
                    !groupStr.toLowerCase().includes(searchTerm) &&
                    !String(m.count).includes(searchTerm) &&
                    !String(m.groups).includes(searchTerm) &&
                    !String(m.boxes).includes(searchTerm) &&
                    !String(m.groupNumber).includes(searchTerm)) {
                    return false;
                }
            }
            if (showUnassigned !== showAssigned) {
                if (showUnassigned && m.done) return false;
                if (showAssigned && !m.done) return false;
            }
            return true;
        });
    }

    function renderAssignAll() {
        renderAssignTable();
        renderAssignStats();
        updateToggleButton();
    }

    function renderAssignTable() {
        const filtered = getFilteredMaterials();

        if (filtered.length === 0) {
            assignTableBody.innerHTML = '';
            assignEmptyState.classList.remove('hidden');
            assignEmptyState.querySelector('p').textContent = materials.length === 0 ? '没有材料数据' : '没有匹配的材料';
            return;
        }
        assignEmptyState.classList.add('hidden');

        let html = '';
        const sorted = [...filtered].sort((a, b) => a.groupNumber - b.groupNumber);
        let lastGroup = -1;

        sorted.forEach((m) => {
            const originalIndex = materials.indexOf(m);
            const doneClass = m.done ? 'completed' : '';
            const statusClass = m.done ? 'done' : '';
            const statusSymbol = m.done ? '&#10003;' : '';

            if (m.groupNumber !== lastGroup) {
                lastGroup = m.groupNumber;
                html += `
                <tr class="group-separator">
                    <td colspan="6">
                        <span class="group-label">材料组 #${m.groupNumber}</span>
                        <span class="group-name">${escapeHTML(m.groupName)}</span>
                    </td>
                </tr>`;
            }

            html += `
            <tr class="${doneClass}" data-index="${originalIndex}">
                <td class="col-idx">${m.groupNumber}</td>
                <td class="col-cn-name">${escapeHTML(m.chineseName || '未知材料')}</td>
                <td class="col-count">${m.count.toLocaleString()}</td>
                <td class="col-groups">${m.groups.toLocaleString()}</td>
                <td class="col-boxes">${m.boxes.toLocaleString()}</td>
                <td class="col-group-num">${m.groupNumber}</td>
            </tr>`;
        });
        assignTableBody.innerHTML = html;
    }

    function renderAssignStats() {
        const total = materials.length;
        const done = materials.filter(m => m.done).length;
        const groupCount = new Set(materials.map(m => m.groupNumber)).size;
        statsSummary.innerHTML = `<strong>${done}</strong> / ${total} 已完成 · <strong>${groupCount}</strong> 个材料组`;
    }

    function updateToggleButton() {
        const allDone = materials.length > 0 && materials.every(m => m.done);
        btnToggleAll.textContent = allDone ? '全部取消标记' : '全部标记完成';
    }

    // --- 事件处理 (Assign) ---
    assignTableBody.addEventListener('click', (e) => {
        // 点击行切换完成状态
        const row = e.target.closest('tr[data-index]');
        if (!row) return;
        const index = parseInt(row.getAttribute('data-index'), 10);
        if (isNaN(index) || index < 0 || index >= materials.length) return;
        materials[index].done = !materials[index].done;
        renderAssignAll();
    });

    searchInput.addEventListener('input', () => renderAssignTable());
    filterUnassigned.addEventListener('change', () => renderAssignTable());
    filterAssigned.addEventListener('change', () => renderAssignTable());

    btnToggleAll.addEventListener('click', () => {
        const allDone = materials.every(m => m.done);
        materials.forEach(m => { m.done = !allDone; });
        renderAssignAll();
    });

    btnResetAll.addEventListener('click', () => {
        if (!confirm('确认重置所有材料的完成状态和分配信息？此操作不可撤销。')) return;
        materials.forEach(m => { m.done = false; m.assignee = ''; });
        renderAssignAll();
    });

    // --- XLSX 导出 ---
    btnExportXlsx.addEventListener('click', () => {
        if (materials.length === 0) {
            showToast('没有可导出的数据');
            return;
        }
        exportXLSX();
    });

    function exportXLSX() {
        if (!materials.length) {
            showToast('没有可导出的数据');
            return;
        }

        var headerRow = ['序号', '中文名称', '总数', '组数', '盒数', '材料组', '材料收集者'];
        var sorted = materials.slice().sort(function (a, b) { return a.groupNumber - b.groupNumber; });
        var dataRows = [];
        var lastGroup = -1;
        var merges = [];

        sorted.forEach(function (m) {
            // 分组分隔行（合并整行，醒目分隔）
            if (m.groupNumber !== lastGroup && lastGroup !== -1) {
                dataRows.push(['═══  材料组 ' + lastGroup + '  ═══', '', '', '', '', '', '']);
                merges.push({ s: { r: dataRows.length, c: 0 }, e: { r: dataRows.length, c: 6 } });
            }
            lastGroup = m.groupNumber;
            dataRows.push([
                m.groupNumber,
                m.chineseName || '',
                m.count,
                m.groups,
                m.boxes,
                '材料组' + m.groupNumber,
                m.assignee || '',
            ]);
        });

        // 汇总行
        if (sorted.length > 0) {
            var totalCount = sorted.reduce(function (s, m) { return s + m.count; }, 0);
            var totalGroups = sorted.reduce(function (s, m) { return s + m.groups; }, 0);
            var totalBoxes = sorted.reduce(function (s, m) { return s + m.boxes; }, 0);
            var groupCount = new Set(sorted.map(function (m) { return m.groupNumber; })).size;

            dataRows.push(['', '', '', '', '', '', '']);
            dataRows.push([
                '', '合计 ' + sorted.length + ' 种材料',
                totalCount, totalGroups, totalBoxes,
                groupCount + ' 个材料组',
                '',
            ]);
        }

        // 构建完整行数组
        var allRows = [headerRow].concat(dataRows);
        var ws = XLSX.utils.aoa_to_sheet(allRows);

        // 列宽
        ws['!cols'] = [
            { wch: 7 }, { wch: 26 }, { wch: 10 }, { wch: 8 },
            { wch: 8 }, { wch: 13 }, { wch: 14 },
        ];

        // 合并分组分隔行
        if (merges.length > 0) {
            ws['!merges'] = [];
            merges.forEach(function (m) {
                ws['!merges'].push({ s: { r: m.s.r, c: m.s.c }, e: { r: m.e.r, c: m.e.c } });
            });
        }

        // 数字格式：总数/组数/盒数列使用千位分隔
        var range = XLSX.utils.decode_range(ws['!ref']);
        for (var R = range.s.r; R <= range.e.r; R++) {
            for (var C = 2; C <= 4; C++) {
                var addr = XLSX.utils.encode_cell({ r: R, c: C });
                if (ws[addr] && typeof ws[addr].v === 'number') {
                    ws[addr].z = '#,##0';
                }
            }
        }

        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '材料分配表');
        XLSX.writeFile(wb, sourceFileName + '_分配表.xlsx');
    }

    // --- Assign 文件上传绑定 ---
    // 注：不使用 JS click 打开文件选择器，HTML <label for="..."> 已处理手机端兼容性
    assignFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleAssignFile(file);
        // 延迟清空，避免手机端 iOS Safari 因同步清空 value 而重新弹出文件选择器
        setTimeout(() => { assignFileInput.value = ''; }, 200);
    });
    assignUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); assignUploadArea.classList.add('drag-over'); });
    assignUploadArea.addEventListener('dragleave', () => assignUploadArea.classList.remove('drag-over'));
    assignUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        assignUploadArea.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleAssignFile(file);
    });

    // ==================================================================
    //  桥接：发送到材料分配
    // ==================================================================
    btnSendToAssign.addEventListener('click', () => {
        if (!currentConvertData || !currentConvertData.blocks.length) {
            showToast('没有可发送的数据，请先加载 .litematic 文件');
            return;
        }
        loadAssignFromConvert(currentConvertData);
        switchTab('assign');
    });

    // ==================================================================
    //  初始化
    // ==================================================================
    function init() {
        showAssignUploadUI();
    }

    init();
})();