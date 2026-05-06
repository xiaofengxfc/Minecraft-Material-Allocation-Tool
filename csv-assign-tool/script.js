/**
 * 材料分配表 — 核心逻辑
 * 
 * 功能：
 *   1. CSV 导入解析（兼容 100w收集_材料表.csv 格式）
 *   2. 材料状态标记（完成/未完成）
 *   3. 分配人编辑
 *   4. 搜索与筛选
 *   5. 进度统计
 *   6. 导出含状态的 XLSX
 *   7. localStorage 持久化
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
    const STORAGE_KEY = 'csv_assign_tool_data';

    /** @type {Array<{name:string, chineseName:string, count:number, groups:number, boxes:number, done:boolean, assignee:string}>} */
    let materials = [];

    /** 当前文件名（用于导出命名） */
    let sourceFileName = 'materials';

    // ==================== 持久化 ====================
    function saveToStorage() {
        try {
            const data = {
                sourceFileName: sourceFileName,
                materials: materials,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // localStorage 满了或不可用，静默忽略
        }
    }

    function loadFromStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.materials) && data.materials.length > 0) {
                sourceFileName = data.sourceFileName || 'materials';
                materials = data.materials;
                // 迁移旧数据：如果使用旧格式（有props字段），清除后重新导入
                if (materials.length > 0 && 'props' in materials[0] && !('groups' in materials[0])) {
                    clearStorage();
                    return false;
                }
                return true;
            }
        } catch (e) {
            // 数据损坏
        }
        return false;
    }

    function clearStorage() {
        localStorage.removeItem(STORAGE_KEY);
    }

    // ==================== CSV 解析 ====================
    /**
     * 解析 CSV 文本为材料数组
     * 兼容两种格式：
     *   新格式：序号,英文名称,中文名称,总数,组数,盒数
     *   旧格式：序号,方块名称,总数,组数,盒数
     *   1,white_stained_glass,白色染色玻璃,1637,26,1
     *   ,合计 256 种方块,6733,319,256
     *   (空行)
     *   文件,100w收集.litematic
     *   尺寸,...
     */
    function parseCSV(text) {
        const rows = [];
        // 去除 BOM
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
        }
        // 规范换行符
        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

        // 检测 CSV 格式：读取表头判断是否有中文名称列
        let hasChineseColumn = false;

        for (const line of lines) {
            // 跳过空行
            const trimmed = line.trim();
            if (!trimmed) continue;

            const cols = splitCSVLine(trimmed);

            // 检测表头
            if (cols.length >= 5) {
                const headerCol1 = cols[1] ? cols[1].trim() : '';
                const headerCol2 = cols[2] ? cols[2].trim() : '';
                if (headerCol1 === '英文名称' && headerCol2 === '中文名称') {
                    hasChineseColumn = true;
                }
            }

            // 跳过元数据行（文件、尺寸、方块总数等，以及以逗号开头的合计行）
            if (cols.length < 4) continue;

            const seq = cols[0].trim();
            const name = cols[1].trim();
            const countIdx = hasChineseColumn ? 3 : 2;
            const groupsIdx = hasChineseColumn ? 4 : 3;
            const boxesIdx = hasChineseColumn ? 5 : 4;
            const countStr = (cols[countIdx] || '').trim();
            const groupsStr = (cols[groupsIdx] || '').trim();
            const boxesStr = (cols[boxesIdx] || '').trim();

            // 跳过表头行
            if (seq === '序号') continue;

            // 跳过合计行（序号列为空或以"合计"开头）
            if (!seq || seq.startsWith('合计')) continue;

            // 跳过元数据标签（文件、尺寸、方块总数、非空气方块、方块种类）
            if (seq === '文件' || seq === '尺寸' || seq === '方块总数' ||
                seq === '非空气方块' || seq === '方块种类') {
                if (name) sourceFileName = name.replace(/\.litematic$/i, '');
                continue;
            }

            const count = parseInt(countStr, 10);
            if (isNaN(count) || count <= 0) continue;
            if (!name) continue;

            const groups = parseInt(groupsStr, 10) || 0;
            const boxes = parseInt(boxesStr, 10) || 0;

            // 读取中文名称（新格式从第3列读取，旧格式用翻译表补全）
            let chineseName = '';
            if (hasChineseColumn) {
                chineseName = (cols[2] || '').trim();
            }
            if (!chineseName && typeof translateBlockName === 'function') {
                chineseName = translateBlockName(name);
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
     * 合并按名称重复的材料条目
     * 同名材料将 count/groups/boxes 求和，中文名称取第一个非空值
     */
    function mergeDuplicateMaterials(rows) {
        const merged = new Map();
        for (const row of rows) {
            const key = row.name;
            if (merged.has(key)) {
                const existing = merged.get(key);
                existing.count += row.count;
                existing.groups += row.groups;
                existing.boxes += row.boxes;
                if (!existing.chineseName && row.chineseName) {
                    existing.chineseName = row.chineseName;
                }
            } else {
                merged.set(key, {
                    name: row.name,
                    chineseName: row.chineseName,
                    count: row.count,
                    groups: row.groups,
                    boxes: row.boxes,
                    done: row.done,
                    assignee: row.assignee,
                });
            }
        }
        return Array.from(merged.values());
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
            saveToStorage();
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
                if (!m.name.toLowerCase().includes(searchTerm) &&
                    !cnName.toLowerCase().includes(searchTerm) &&
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
            filtered.forEach((m) => {
                const originalIndex = materials.indexOf(m);
                const doneClass = m.done ? 'completed' : '';
                const statusClass = m.done ? 'done' : '';
                const statusSymbol = m.done ? '&#10003;' : '';

                html += `
                <tr class="${doneClass}" data-index="${originalIndex}">
                    <td class="col-status">
                        <button class="status-btn ${statusClass}" data-action="toggle" data-index="${originalIndex}">
                            ${statusSymbol}
                        </button>
                    </td>
                    <td class="col-idx">${originalIndex + 1}</td>
                    <td class="col-cn-name">${escapeHTML(m.chineseName || m.name)}</td>
                    <td class="col-count">${m.count.toLocaleString()}</td>
                    <td class="col-groups">${m.groups.toLocaleString()}</td>
                    <td class="col-boxes">${m.boxes.toLocaleString()}</td>
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
        statsSummary.innerHTML = `<strong>${done}</strong> / ${total} 已完成`;
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
        saveToStorage();
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
        saveToStorage();
        renderAll();
    });

    // 重置全部
    btnResetAll.addEventListener('click', () => {
        if (!confirm('确认重置所有材料的完成状态和分配信息？此操作不可撤销。')) return;
        materials.forEach((m) => {
            m.done = false;
            m.assignee = '';
        });
        saveToStorage();
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
        const headerRow = ['序号', '英文名称', '中文名称', '总数', '组数', '盒数', '材料收集者'];

        const dataRows = materials.map((m, index) => [
            index + 1,
            m.name,
            m.chineseName || '',
            m.count,
            m.groups,
            m.boxes,
            m.assignee
        ]);

        const totalDone = materials.filter((m) => m.done).length;
        const summaryRow = ['总计', materials.length + ' 种材料（已完成 ' + totalDone + ' 种）', '', '', '', '', ''];

        const allRows = [headerRow, ...dataRows, summaryRow];

        const ws = XLSX.utils.aoa_to_sheet(allRows);

        // 设置列宽
        ws['!cols'] = [
            { wch: 8 },   // 序号
            { wch: 26 },  // 英文名称
            { wch: 18 },  // 中文名称
            { wch: 10 },  // 总数
            { wch: 8 },   // 组数
            { wch: 8 },   // 盒数
            { wch: 12 }   // 材料收集者
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

    function csvEscape(str) {
        if (!str) return '';
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
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
        // 始终先显示上传界面，只有导入CSV后才显示进度和材料列表
        showUploadUI();
    }

    init();
})();