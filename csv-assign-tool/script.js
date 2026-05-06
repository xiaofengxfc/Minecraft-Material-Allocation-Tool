/**
 * 材料分配表 — 核心逻辑
 * 
 * 功能：
 *   1. CSV 导入解析（兼容 Litematic 材料表转换器导出的格式）
 *   2. 材料状态标记（完成/未完成）
 *   3. 搜索与筛选
 *   4. 进度统计
 *   5. 材料自动分组（按同类型材料归类为材料组）
 *   6. 导出含状态的 XLSX
 */

(function () {
    'use strict';

    // ==================== DOM 引用 ====================
    const uploadArea   = document.getElementById('upload-area');
    const uploadSection = document.getElementById('upload-section');
    const fileInput    = document.getElementById('file-input');
    const toolbar      = document.getElementById('toolbar');
    const searchInput  = document.getElementById('search-input');
    const filterUnassigned = document.getElementById('filter-unassigned');
    const filterAssigned   = document.getElementById('filter-assigned');
    const statsSummary     = document.getElementById('stats-summary');
    const btnResetAll      = document.getElementById('btn-reset-all');
    const btnExportCsv     = document.getElementById('btn-export-csv');
    const btnToggleAll     = document.getElementById('btn-toggle-all');
    const progressSection  = document.getElementById('progress-section');
    const progressPercent  = document.getElementById('progress-percent');
    const progressFill     = document.getElementById('progress-fill');
    const progressDetail   = document.getElementById('progress-detail');
    const tableSection     = document.getElementById('table-section');
    const tableBody        = document.getElementById('table-body');
    const emptyState       = document.getElementById('empty-state');

    // ==================== 状态 ====================
    /** @type {Array<{name:string, chineseName:string, count:number, groups:number, boxes:number, done:boolean, assignee:string, groupName:string, groupNumber:number}>} */
    let materials = [];

    /** 当前文件名（用于导出命名） */
    let sourceFileName = 'materials';

    // ==================== 材料分组 ====================
    /**
     * Minecraft 材料常见的前缀（颜色、材质变种等），需要被剥离以提取基础类型
     * 注意：顺序很重要，长前缀优先匹配
     */
    const MATERIAL_PREFIXES = [
        // 颜色类（染色变种）
        '淡灰色', '淡蓝色', '淡灰色', '黄绿色', '品红色',
        '白色', '橙色', '品红', '淡蓝', '黄色', '黄绿',
        '粉色', '灰色', '淡灰', '青色', '紫色', '蓝色',
        '棕色', '绿色', '红色', '黑色',
        // 木质变种
        '去皮', '去皮深色', '去皮白桦', '去皮云杉', '去皮丛林',
        '去皮金合欢', '去皮深板岩', '去皮绯红', '去皮诡异',
        '深色橡木', '白桦木', '云杉木', '丛林木', '金合欢木',
        '深板岩', '绯红', '诡异',
        '橡木', '白桦', '云杉', '丛林', '金合欢', '深色',
        // 石质变种
        '錾制', '錾制深板岩', '磨制', '磨制黑石', '磨制深板岩',
        '裂纹', '裂纹深板岩', '裂纹下界砖',
        '苔石', '苔石砖',
        '平滑', '平滑石头', '平滑砂岩', '平滑红砂岩', '平滑石英',
        '錾制石砖', '錾制砂岩', '錾制红砂岩', '錾制下界砖',
        '錾制石英',
        // 其他常见前缀
        '充能', '激活', '失活', '触发', '侦测',
        '暗海晶', '海晶', '海晶石',
        '紫珀', '末地',
        '下界', '下界砖',
        '红砖',
        '沙石', '砂岩', '红沙', '红砂岩',
        '粗铁', '粗金', '粗铜',
        '铁', '金', '钻石', '下界合金',
        '锁链', '灯笼',
        '营火', '灵魂营火',
        '高炉', '烟熏炉', '熔炉', '酿造台',
        '阳光', '月光',
        '黏性', '黏液',
        '失明',
        '深板岩',
        '红石',
        '发射', '投掷',
    ];

    /**
     * 从中文材料名称中提取基础类型（剥离前缀）
     * 例如："白色染色玻璃" → "染色玻璃"
     *       "橡木木板" → "木板"
     *       "石头" → "石头"（无匹配前缀时返回自身）
     * @param {string} cnName
     * @returns {string}
     */
    function extractBaseType(cnName) {
        if (!cnName) return '';

        // 按长度降序排列前缀，优先匹配更长的前缀
        const sorted = [...MATERIAL_PREFIXES].sort((a, b) => b.length - a.length);

        for (const prefix of sorted) {
            if (cnName.startsWith(prefix)) {
                const rest = cnName.slice(prefix.length);
                // 只剥离完整的前缀词，避免误匹配
                // 例如 "石头" 不应被 "石" 匹配而从 "头" 开始
                if (rest.length >= 1) {
                    return rest;
                }
            }
        }

        // 没有匹配到前缀，返回自身
        return cnName;
    }

    /**
     * 为材料数组分配分组
     * 规则：
     *   1. 提取每个材料的基础类型
     *   2. 相同基础类型的材料归为同一材料组
     *   3. 只有1种材料的组保持独立（不合并）
     *   4. 组号从1开始
     * @param {Array} mats
     */
    function assignGroups(mats) {
        // 第一步：计算每个材料的基础类型
        const baseTypeMap = new Map(); // chineseName → baseType
        for (const m of mats) {
            baseTypeMap.set(m.chineseName, extractBaseType(m.chineseName));
        }

        // 第二步：按基础类型分组
        const groupMap = new Map(); // baseType → [材料索引数组]
        for (let i = 0; i < mats.length; i++) {
            const bt = baseTypeMap.get(mats[i].chineseName);
            if (!groupMap.has(bt)) {
                groupMap.set(bt, []);
            }
            groupMap.get(bt).push(i);
        }

        // 第三步：分配组号（从1开始），只有多材料组才编号
        let groupNumber = 1;

        for (const [baseType, indices] of groupMap) {
            if (indices.length <= 1) {
                // 单一材料，groupName 为空，groupNumber 为 0
                mats[indices[0]].groupName = '';
                mats[indices[0]].groupNumber = 0;
            } else {
                // 多材料组，分配组号
                const gn = groupNumber++;
                for (const idx of indices) {
                    mats[idx].groupName = baseType;
                    mats[idx].groupNumber = gn;
                }
            }
        }
    }

    // ==================== CSV 解析 ====================
    /**
     * 解析 CSV 文本为材料数组
     * 
     * 新格式（无英文名称列）：
     *   序号,中文名称,总数,组数,盒数
     *   1,白色染色玻璃,1637,26,1
     *   ,,合计 256 种方块,6733,319,256
     *   (空行)
     *   文件,100w收集.litematic
     *   尺寸,...
     * 
     * 旧格式（有英文名称列，兼容）：
     *   序号,英文名称,中文名称,总数,组数,盒数
     */
    function parseCSV(text) {
        const rows = [];
        // 去除 BOM
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
        }
        // 规范换行符
        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

        // 检测 CSV 格式：读取表头判断是否有英文名称列
        let hasEnglishColumn = false;

        for (const line of lines) {
            // 跳过空行
            const trimmed = line.trim();
            if (!trimmed) continue;

            const cols = splitCSVLine(trimmed);

            // 检测表头
            if (cols.length >= 4) {
                const headerCol1 = cols[1] ? cols[1].trim() : '';
                const headerCol2 = cols[2] ? cols[2].trim() : '';
                if (headerCol1 === '英文名称') {
                    hasEnglishColumn = true;
                }
                // 新格式表头：序号,中文名称,... (col1='中文名称')
                // 旧格式表头：序号,英文名称,中文名称,... (col1='英文名称', col2='中文名称')
                break;
            }
        }

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const cols = splitCSVLine(trimmed);

            if (cols.length < 3) continue;

            const seq = cols[0].trim();

            // 确定各列索引
            let cnColIdx, countIdx, groupsIdx, boxesIdx;
            if (hasEnglishColumn) {
                // 旧格式：序号,英文名称,中文名称,总数,组数,盒数
                cnColIdx = 2;
                countIdx = 3;
                groupsIdx = 4;
                boxesIdx = 5;
            } else {
                // 新格式：序号,中文名称,总数,组数,盒数
                cnColIdx = 1;
                countIdx = 2;
                groupsIdx = 3;
                boxesIdx = 4;
            }

            const chineseName = (cols[cnColIdx] || '').trim();
            const countStr = (cols[countIdx] || '').trim();
            const groupsStr = (cols[groupsIdx] || '').trim();
            const boxesStr = (cols[boxesIdx] || '').trim();

            // 跳过表头行
            if (seq === '序号') continue;

            // 跳过合计行（序号列为空、中文名称列以"合计"开头）
            if (!seq) continue;
            if (seq.startsWith('合计') || chineseName.startsWith('合计')) continue;

            // 跳过元数据标签
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

            // 用中文名称作为主键（name），chineseName 也保留
            // translateBlockName 用于兜底翻译
            let name = chineseName;
            // 如果是旧格式有英文名称列，尝试读取
            if (hasEnglishColumn) {
                const enName = (cols[1] || '').trim();
                if (enName && enName !== '英文名称') {
                    name = enName;
                }
            }

            rows.push({
                name: name,
                chineseName: chineseName,
                count: count,
                groups: groups,
                boxes: boxes,
                done: false,
                assignee: '',
            });
        }

        // 去重合并：同名材料合并 count/groups/boxes
        return mergeDuplicateMaterials(rows);
    }

    /**
     * 合并按中文名称重复的材料条目
     * 去重策略：
     *   - 按 chineseName 合并（大小写不敏感）
     *   - 合并后从 count 重新计算 groups/boxes
     */
    function mergeDuplicateMaterials(rows) {
        const map = new Map();

        for (const row of rows) {
            const cnKey = (row.chineseName || '').toLowerCase().trim();
            if (!cnKey) continue;

            if (map.has(cnKey)) {
                const existing = map.get(cnKey);
                existing.count += row.count;
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

        // 从合并后的 count 重新计算 groups 和 boxes
        for (const item of merged) {
            item.groups = Math.ceil(item.count / 64);
            item.boxes = Math.ceil(item.groups / 27);
        }

        return merged;
    }

    /**
     * 分割 CSV 行（正确处理引号包裹的字段）
     */
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

    // ==================== 文件处理 ====================
    async function handleFile(file) {
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

            // 分配材料组
            assignGroups(materials);

            showMainUI();
            renderAll();
        } catch (err) {
            showToast('CSV 解析失败：' + err.message);
            console.error(err);
        }
    }

    // ==================== UI 切换 ====================
    function showMainUI() {
        uploadSection.classList.add('hidden');
        toolbar.classList.remove('hidden');
        progressSection.classList.remove('hidden');
        tableSection.classList.remove('hidden');
    }

    function showUploadUI() {
        uploadSection.classList.remove('hidden');
        toolbar.classList.add('hidden');
        progressSection.classList.add('hidden');
        tableSection.classList.add('hidden');
    }

    // ==================== 渲染 ====================
    function getFilteredMaterials() {
        const searchTerm = searchInput.value.trim().toLowerCase();
        const showUnassigned = filterUnassigned.checked;
        const showAssigned = filterAssigned.checked;

        return materials.filter((m, index) => {
            // 搜索匹配
            if (searchTerm) {
                const idxStr = String(index + 1);
                const countStr = String(m.count);
                const groupsStr = String(m.groups);
                const boxesStr = String(m.boxes);
                const cnName = m.chineseName || '';
                const groupStr = m.groupNumber > 0 ? '材料组' + m.groupNumber : '';
                if (!cnName.toLowerCase().includes(searchTerm) &&
                    !groupStr.toLowerCase().includes(searchTerm) &&
                    !countStr.includes(searchTerm) &&
                    !groupsStr.includes(searchTerm) &&
                    !boxesStr.includes(searchTerm) &&
                    !idxStr.includes(searchTerm)) {
                    return false;
                }
            }

            // 筛选器：如果两个都勾选或都不勾选，显示全部
            if (showUnassigned !== showAssigned) {
                if (showUnassigned && m.done) return false;
                if (showAssigned && !m.done) return false;
            }

            return true;
        });
    }

    function renderAll() {
        renderTable();
        renderProgress();
        renderStats();
        updateToggleButton();
    }

    function renderTable() {
        const filtered = getFilteredMaterials();

        if (filtered.length === 0) {
            tableBody.innerHTML = '';
            emptyState.classList.remove('hidden');
            if (materials.length === 0) {
                emptyState.querySelector('p').textContent = '没有材料数据';
            } else {
                emptyState.querySelector('p').textContent = '没有匹配的材料';
            }
        } else {
            emptyState.classList.add('hidden');
            let html = '';

            // 按材料组排序：同组材料排在一起
            const sorted = [...filtered].sort((a, b) => {
                if (a.groupNumber !== b.groupNumber) {
                    if (a.groupNumber === 0) return 1;
                    if (b.groupNumber === 0) return -1;
                    return a.groupNumber - b.groupNumber;
                }
                return 0;
            });

            let lastGroup = -1;
            sorted.forEach((m) => {
                const originalIndex = materials.indexOf(m);
                const doneClass = m.done ? 'completed' : '';
                const statusClass = m.done ? 'done' : '';
                const statusSymbol = m.done ? '&#10003;' : '';

                // 材料组分隔行
                if (m.groupNumber > 0 && m.groupNumber !== lastGroup) {
                    lastGroup = m.groupNumber;
                    html += `
                    <tr class="group-separator">
                        <td colspan="7">
                            <span class="group-label">材料组 #${m.groupNumber}</span>
                            <span class="group-name">${escapeHTML(m.groupName)}</span>
                        </td>
                    </tr>`;
                }

                html += `
                <tr class="${doneClass}" data-index="${originalIndex}">
                    <td class="col-status">
                        <button class="status-btn ${statusClass}" data-action="toggle" data-index="${originalIndex}">
                            ${statusSymbol}
                        </button>
                    </td>
                    <td class="col-idx">${originalIndex + 1}</td>
                    <td class="col-cn-name">${escapeHTML(m.chineseName || '未知材料')}</td>
                    <td class="col-count">${m.count.toLocaleString()}</td>
                    <td class="col-groups">${m.groups.toLocaleString()}</td>
                    <td class="col-boxes">${m.boxes.toLocaleString()}</td>
                    <td class="col-group-num">${m.groupNumber > 0 ? m.groupNumber : ''}</td>
                </tr>`;
            });
            tableBody.innerHTML = html;
        }
    }

    function renderProgress() {
        const total = materials.length;
        const done = materials.filter((m) => m.done).length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        progressPercent.textContent = pct + '%';
        progressFill.style.width = pct + '%';
        progressDetail.textContent = `${done} / ${total} 种材料已完成`;
    }

    function renderStats() {
        const total = materials.length;
        const done = materials.filter((m) => m.done).length;
        const groupCount = new Set(
            materials
                .filter((m) => m.groupNumber > 0)
                .map((m) => m.groupNumber)
        ).size;
        statsSummary.innerHTML = `<strong>${done}</strong> / ${total} 已完成 · <strong>${groupCount}</strong> 个材料组`;
    }

    function updateToggleButton() {
        const allDone = materials.length > 0 && materials.every((m) => m.done);
        btnToggleAll.textContent = allDone ? '全部取消标记' : '全部标记完成';
    }

    // ==================== 事件处理 ====================
    tableBody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="toggle"]');
        if (!btn) return;

        const index = parseInt(btn.getAttribute('data-index'), 10);
        if (isNaN(index) || index < 0 || index >= materials.length) return;

        materials[index].done = !materials[index].done;
        renderAll();
    });

    // 搜索输入
    searchInput.addEventListener('input', () => {
        renderTable();
    });

    // 筛选器
    filterUnassigned.addEventListener('change', () => {
        renderTable();
    });

    filterAssigned.addEventListener('change', () => {
        renderTable();
    });

    // 全部标记/取消
    btnToggleAll.addEventListener('click', () => {
        const allDone = materials.every((m) => m.done);
        materials.forEach((m) => { m.done = !allDone; });
        renderAll();
    });

    // 重置全部
    btnResetAll.addEventListener('click', () => {
        if (!confirm('确认重置所有材料的完成状态和分配信息？此操作不可撤销。')) return;
        materials.forEach((m) => {
            m.done = false;
            m.assignee = '';
        });
        renderAll();
    });

    // 导出 XLSX
    btnExportCsv.addEventListener('click', () => {
        if (materials.length === 0) {
            showToast('没有可导出的数据');
            return;
        }
        exportXLSX();
    });

    // ==================== XLSX 导出 ====================
    function exportXLSX() {
        const headerRow = ['序号', '中文名称', '总数', '组数', '盒数', '材料组', '材料收集者'];

        // 按材料组排序后导出
        const sorted = [...materials].sort((a, b) => {
            if (a.groupNumber !== b.groupNumber) {
                if (a.groupNumber === 0) return 1;
                if (b.groupNumber === 0) return -1;
                return a.groupNumber - b.groupNumber;
            }
            return 0;
        });

        const dataRows = sorted.map((m, index) => [
            index + 1,
            m.chineseName || '',
            m.count,
            m.groups,
            m.boxes,
            m.groupNumber > 0 ? '材料组' + m.groupNumber : '',
            m.assignee
        ]);

        const totalDone = materials.filter((m) => m.done).length;
        const groupCount = new Set(
            materials
                .filter((m) => m.groupNumber > 0)
                .map((m) => m.groupNumber)
        ).size;
        const summaryRow = ['总计', materials.length + ' 种材料（已完成 ' + totalDone + ' 种，共 ' + groupCount + ' 个材料组）', '', '', '', '', ''];

        const allRows = [headerRow, ...dataRows, summaryRow];

        const ws = XLSX.utils.aoa_to_sheet(allRows);

        // 设置列宽
        ws['!cols'] = [
            { wch: 8 },   // 序号
            { wch: 22 },  // 中文名称
            { wch: 10 },  // 总数
            { wch: 8 },   // 组数
            { wch: 8 },   // 盒数
            { wch: 12 },  // 材料组
            { wch: 14 }   // 材料收集者
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '材料分配表');

        XLSX.writeFile(wb, sourceFileName + '_分配表.xlsx');
    }

    // ==================== 文件上传绑定 ====================
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleFile(file);
        fileInput.value = '';
    });

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
        if (file) handleFile(file);
    });

    // ==================== 工具函数 ====================
    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function showToast(message) {
        // 简单的提示
        const existing = document.querySelector('.toast-message');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'toast-message';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            bottom: 32px;
            left: 50%;
            transform: translateX(-50%);
            padding: 10px 24px;
            background: #3a3733;
            color: #fff;
            border-radius: 6px;
            font-size: 0.88rem;
            z-index: 9999;
            box-shadow: 0 4px 14px rgba(0,0,0,0.18);
            animation: toastIn 240ms ease, toastOut 240ms ease 2s forwards;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    // 动态注入 toast 动画
    const toastStyle = document.createElement('style');
    toastStyle.textContent = `
        @keyframes toastIn {
            from { opacity: 0; transform: translateX(-50%) translateY(12px); }
            to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes toastOut {
            from { opacity: 1; }
            to   { opacity: 0; }
        }
    `;
    document.head.appendChild(toastStyle);

    // ==================== 初始化 ====================
    function init() {
        showUploadUI();
    }

    init();
})();