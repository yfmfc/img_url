/**
 * Image Toolkit —— SillyTavern 图片工具箱
 *
 * 功能：
 *   1. 聊天记录清理：按“最后聊天时间距今 N 天”扫描角色卡并批量删除聊天
 *   2. 图片插入：图片库 + 宏 {{img::图片名}}，放在世界书 / 角色描述 / 预设 / 聊天的任意位置，
 *      请求发出时解析为图片内容块，让模型直接看到图片
 *   3. Preset JSON 整理器：按 prompt_order 的顺序重排 prompts 数组，其余原样保留
 *   4. 图片格式转换：JPG / PNG 互转 + 质量 / 缩放压缩
 *
 * 界面挂载在 SillyTavern 的扩展设置抽屉里，全部控件使用原生样式类与主题变量，
 * 自动跟随当前主题，移动端自适应。
 */

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    getRequestHeaders,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';

// ---------------------------------------------------------------------------
// 常量 & 设置
// ---------------------------------------------------------------------------

const EXT_NAME = 'Image Toolkit';
const EXT_ID = 'stImageToolkit';
const MACRO_NAME = 'img';
const DB_NAME = 'st-image-toolkit';
const DB_STORE = 'images';

const DEFAULT_SETTINGS = {
    images: {
        mode: 'image',          // 发送模式：image=发送图片内容块 | text=输出文字标记 | off=宏输出为空
        autoCompress: true,     // 上传时自动压缩
        maxEdge: 1280,          // 自动压缩最长边
        quality: 0.85,          // 自动压缩质量
    },
    imageMeta: [],              // 图片元数据 [{id, name, mime, bytes, width, height, created}]
    cleanup: {
        days: 30,
        mode: 'character',      // character=按角色最后聊天时间 | chat=按每条聊天最后消息时间
    },
    convert: {
        format: 'image/jpeg',
        quality: 0.85,
        scale: 1,
    },
};

/** 读取设置并补齐缺失字段，保证默认值始终可用 */
function S() {
    const root = extension_settings[EXT_ID] ?? (extension_settings[EXT_ID] = {});
    for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
        if (root[key] === undefined || root[key] === null) {
            root[key] = Array.isArray(def) ? [] : { ...def };
        } else if (typeof def === 'object' && !Array.isArray(def)) {
            for (const [k, v] of Object.entries(def)) {
                if (root[key][k] === undefined) root[key][k] = v;
            }
        }
    }
    return root;
}

function persist() {
    try { saveSettingsDebounced(); } catch (e) { console.warn(EXT_NAME, e); }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c === undefined || c === null) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(ms) {
    const t = Number(ms);
    if (!t) return '—';
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function uid() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toast(kind, msg) {
    try { toastr[kind](msg); } catch { console.log(EXT_NAME, kind, msg); }
}

function confirmPopup(text, okTitle = '确定') {
    const popup = new Popup(el('div', { text }), POPUP_TYPE.CONFIRM, '', {
        okButton: okTitle,
        cancelButton: '取消',
        wide: false,
    });
    return popup.show();
}

/** 点击缩略图预览大图（ST 原生弹窗，自带 X / ESC 退出） */
function previewImage(dataUrl, name) {
    const img = el('img', {
        src: dataUrl, alt: name,
        style: { maxWidth: '80vw', maxHeight: '72vh', display: 'block', margin: '0 auto', borderRadius: '8px' },
    });
    const wrap = el('div', {}, [
        img,
        el('div', { class: 'st-itk-hint', text: name, style: { textAlign: 'center', marginTop: '8px' } }),
    ]);
    new Popup(wrap, POPUP_TYPE.DISPLAY).show();
}

/** 让 textarea 滚动到指定字符位置附近 */
function scrollTextareaTo(ta, index) {
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 16;
    const lines = ta.value.slice(0, index).split('\n').length;
    ta.scrollTop = Math.max(0, (lines - 3) * lineHeight);
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = dataUrl;
    });
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

// ---------------------------------------------------------------------------
// IndexedDB：图片本体存储（大图存数据库，设置文件保持轻量）
// ---------------------------------------------------------------------------

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

async function idbPut(id, dataUrl) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(dataUrl, id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function idbGet(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

async function idbDelete(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

// ---------------------------------------------------------------------------
// 图片库（宏的数据源）
// ---------------------------------------------------------------------------

/** 图片索引：名称 → {id, name, dataUrl} */
const imageIndex = new Map();

function indexImage(meta, dataUrl) {
    imageIndex.set(String(meta.name).trim(), { id: meta.id, name: meta.name, dataUrl });
}

function unindexImage(name) {
    imageIndex.delete(String(name).trim());
}

function uniqueName(base) {
    const names = new Set(S().imageMeta.map(x => x.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} #${i}`)) i++;
    return `${base} #${i}`;
}

/** 把图片压缩到最长边 maxEdge 内（可选），返回 {dataUrl, width, height, mime} */
async function normalizeImage(file) {
    const set = S().images;
    let dataUrl = await readFileAsDataURL(file);
    const img = await loadImageFromDataUrl(dataUrl);
    let { width, height } = img;
    const edge = Math.max(width, height);
    if (!set.autoCompress || edge <= set.maxEdge) {
        return { dataUrl, width, height, mime: file.type || 'image/png' };
    }
    const scale = set.maxEdge / edge;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = el('canvas', { width: w, height: h });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const keepPng = (file.type === 'image/png' || file.type === 'image/webp' || !file.type);
    const mime = keepPng ? 'image/png' : 'image/jpeg';
    const out = canvas.toDataURL(mime, set.quality);
    return { dataUrl: out, width: w, height: h, mime };
}

async function addImages(files) {
    const added = [];
    for (const file of files) {
        if (!file.type.startsWith('image/')) {
            toast('warning', `已跳过非图片文件：${file.name}`);
            continue;
        }
        try {
            const norm = await normalizeImage(file);
            const base = file.name.replace(/\.[^.]+$/, '') || '图片';
            const name = uniqueName(base);
            const meta = {
                id: uid(),
                name,
                mime: norm.mime,
                bytes: Math.round(norm.dataUrl.length * 0.75),
                width: norm.width,
                height: norm.height,
                created: Date.now(),
            };
            await idbPut(meta.id, norm.dataUrl);
            S().imageMeta.push(meta);
            indexImage(meta, norm.dataUrl);
            added.push(meta);
        } catch (e) {
            console.error(EXT_NAME, e);
            toast('error', `${file.name} 处理失败：${e.message}`);
        }
    }
    persist();
    renderImageList();
    return added;
}

async function removeImage(meta) {
    unindexImage(meta.name);
    await idbDelete(meta.id).catch(() => {});
    S().imageMeta = S().imageMeta.filter(x => x.id !== meta.id);
    persist();
    renderImageList();
}

// ---------------------------------------------------------------------------
// 图片宏：{{img::图片名}} → 提示词中的图片占位符
// ---------------------------------------------------------------------------
//
// 数据流：宏展开只写入极小的占位符 <img data-itk="图片名">，base64 全程不进
// 提示词；请求组装完成时，占位符被解析为与原生图片附件一致的图片内容块。

let macroApi = null;

/** 按当前发送模式生成宏输出 */
function buildMacroOutput(name) {
    const key = String(name || '').trim();
    const mode = S().images.mode;
    if (mode === 'off') return '';
    if (!imageIndex.has(key)) {
        console.warn(`${EXT_NAME}: 未找到图片 "${key}"`);
        return '';
    }
    if (mode === 'text') return `[图片: ${key}]`;
    return `<img data-itk="${key}" alt="${key}">`;
}

/** 向 SillyTavern 宏引擎注册 {{img::图片名}} */
async function registerImageMacro() {
    try {
        const mod = await import('../../../macros/macro-system.js');
        macroApi = mod.macros || null;
    } catch { /* 当前环境未提供宏引擎 */ }
    if (typeof macroApi?.register !== 'function') {
        console.error(`${EXT_NAME}: 未找到宏引擎 macros/macro-system.js，请升级 SillyTavern`);
        toast('error', '未找到宏引擎，请升级 SillyTavern');
        return;
    }
    try {
        macroApi.register(MACRO_NAME, {
            category: macroApi.category?.CORE ?? 'core',
            description: '把图片库中的图片插入提示词（请求发出时解析为图片内容块）',
            displayOverride: '{{img::图片名}}',
            exampleUsage: ['{{img::角色立绘}}'],
            unnamedArgs: [{ name: 'name', optional: false, sampleValue: '角色立绘', description: '图片库中的图片名' }],
            handler: (ctx) => buildMacroOutput(ctx?.unnamedArgs?.[0] ?? ctx?.args?.[0] ?? ''),
        });
        console.log(`${EXT_NAME}: 宏 {{img::图片名}} 注册完成`);
    } catch (e) {
        console.error(`${EXT_NAME}: 宏注册失败`, e);
    }
}

// ---------------------------------------------------------------------------
// 请求改写：占位符 → 图片内容块
// ---------------------------------------------------------------------------
//
// 通过 SillyTavern 官方事件在请求组装完成时改写，图片内容块与原生附件同构
// （{type:'image_url', image_url:{url}}），服务端自动适配各家 API 格式。

/** 匹配图片占位符：<img data-itk="图片名"> */
const PLACEHOLDER_RE = /<img\b[^>]*\bdata-itk\s*=\s*["'][^"']*["'][^>]*>/gi;

/** 读取 img 标签的属性值 */
function getAttr(tagHtml, attr) {
    const m = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tagHtml);
    return m ? m[1] : '';
}

/** 按名称查询图片地址，命中返回 {url, name}，否则返回 null */
function resolveImageRef(tagHtml) {
    const name = getAttr(tagHtml, 'data-itk').trim();
    const entry = name ? imageIndex.get(name) : null;
    return entry?.dataUrl ? { url: entry.dataUrl, name } : null;
}

/** 合并相邻文本块，过滤空文本 */
function mergeTextParts(parts) {
    const out = [];
    for (const p of parts) {
        const last = out[out.length - 1];
        if (p.type === 'text' && last && last.type === 'text') last.text += p.text;
        else out.push(p);
    }
    return out.filter(p => p.type !== 'text' || p.text.length);
}

/** 文本中的占位符 → 图片内容块；没有占位符时返回 null */
function splitImageTags(text) {
    if (typeof text !== 'string' || !text.includes('data-itk')) return null;
    const parts = [];
    const re = new RegExp(PLACEHOLDER_RE.source, 'gi');
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const ref = resolveImageRef(m[0]);
        const name = ref?.name || getAttr(m[0], 'data-itk').trim();
        if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
        // 命中图片库 → 图片内容块；图片已不存在 → 文字标记
        parts.push(ref
            ? { type: 'image_url', image_url: { url: ref.url } }
            : { type: 'text', text: `[图片: ${name}]` });
        last = m.index + m[0].length;
    }
    if (!parts.length) return null;
    if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
    return mergeTextParts(parts);
}

/** 文本中的占位符 → [图片: 名称] 文字标记 */
function replaceWithMarkers(text) {
    return text.replace(new RegExp(PLACEHOLDER_RE.source, 'gi'), (tag) => {
        const name = getAttr(tag, 'data-itk').trim();
        return name ? `[图片: ${name}]` : '[图片]';
    });
}

/**
 * 改写消息内容，返回新内容（无改动返回 null）。
 * image 模式 → 图片内容块；text 模式 → [图片: 名称] 文字标记。
 */
function transformMessageContent(content, mode) {
    if (typeof content === 'string') {
        if (!content.includes('data-itk')) return null;
        return mode === 'image' ? splitImageTags(content) : replaceWithMarkers(content);
    }
    if (Array.isArray(content)) {
        let changed = false;
        const out = [];
        for (const part of content) {
            if (part && part.type === 'text' && typeof part.text === 'string' && part.text.includes('data-itk')) {
                const next = mode === 'image'
                    ? splitImageTags(part.text)
                    : [{ type: 'text', text: replaceWithMarkers(part.text) }];
                if (next) { out.push(...next); changed = true; continue; }
            }
            out.push(part);
        }
        return changed ? out : null;
    }
    return null;
}

/** 改写一批聊天消息，返回改写条数 */
function transformChatMessages(chat) {
    if (!Array.isArray(chat)) return 0;
    const mode = S().images.mode === 'image' ? 'image' : 'text';
    let count = 0;
    for (const msg of chat) {
        if (!msg) continue;
        const next = transformMessageContent(msg.content, mode);
        if (next !== null) { msg.content = next; count++; }
    }
    return count;
}

/**
 * 挂接 SillyTavern 官方请求流水线事件：
 *   - CHAT_COMPLETION_PROMPT_READY：聊天补全请求的 messages
 *   - GENERATE_AFTER_COMBINE_PROMPTS：纯文本补全请求的 prompt
 * 两类请求全覆盖，图片只出现在图片内容块或文字标记里。
 */
function hookRequestPipeline() {
    const ready = event_types?.CHAT_COMPLETION_PROMPT_READY;
    const combined = event_types?.GENERATE_AFTER_COMBINE_PROMPTS;
    if (typeof eventSource?.on !== 'function' || !ready || !combined) {
        console.error(`${EXT_NAME}: 未找到 SillyTavern 请求事件，请升级 SillyTavern`);
        toast('error', '未找到请求事件，请升级 SillyTavern');
        return;
    }

    // 聊天补全：占位符解析为图片内容块
    eventSource.on(ready, (eventData) => {
        try {
            if (eventData?.dryRun) return;
            const count = transformChatMessages(eventData?.chat);
            if (count) console.log(`${EXT_NAME}: 已为 ${count} 条消息解析图片内容块`);
        } catch (e) {
            console.warn(`${EXT_NAME}: 改写聊天消息时出现问题`, e);
        }
    });

    // 纯文本补全：图片以文字标记呈现（纯文本 API 本身不承载图片）
    eventSource.on(combined, (eventData) => {
        try {
            if (eventData?.dryRun) return;
            if (typeof eventData?.prompt === 'string' && eventData.prompt.includes('data-itk')) {
                eventData.prompt = replaceWithMarkers(eventData.prompt);
            }
        } catch (e) {
            console.warn(`${EXT_NAME}: 改写文本提示词时出现问题`, e);
        }
    });
}

// ---------------------------------------------------------------------------
// 聊天记录清理
// ---------------------------------------------------------------------------

async function apiPost(path, payload) {
    const res = await fetch(path, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload ?? {}),
    });
    if (!res.ok) throw new Error(`接口 ${path} 返回 ${res.status}`);
    return res.json();
}

async function scanOldChats() {
    const set = S().cleanup;
    const days = Math.max(0, Number(set.days) || 0);
    const cutoff = Date.now() - days * 86400000;
    const mode = set.mode;
    const status = ui.cleanupStatus;
    const bar = ui.cleanupBar;
    status.textContent = '正在读取角色列表…';
    bar.style.width = '5%';

    let chars;
    try {
        chars = await apiPost('/api/characters/all', {});
    } catch (e) {
        status.textContent = `扫描失败：${e.message}`;
        return;
    }

    const candidates = (Array.isArray(chars) ? chars : []).filter(c => {
        if (!c || !c.avatar || !Number(c.date_last_chat)) return false; // 跳过没有聊天记录的角色
        return mode === 'character' ? Number(c.date_last_chat) < cutoff : true;
    });

    status.textContent = `角色 ${chars.length} 个，需要检查 ${candidates.length} 个，正在逐个读取聊天…`;
    ui.cleanupResult.dataset.ready = '0';

    const groups = [];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        bar.style.width = `${Math.round(5 + (i / Math.max(1, candidates.length)) * 90)}%`;
        status.textContent = `[${i + 1}/${candidates.length}] ${c.name} …`;
        try {
            const chats = await apiPost('/api/characters/chats', { avatar_url: c.avatar });
            const items = (Array.isArray(chats) ? chats : []).filter(ch => {
                if (!ch || !ch.file_name) return false;
                return mode === 'character' ? true : Number(ch.last_mes || 0) < cutoff;
            });
            if (items.length) groups.push({ char: c, chats: items });
        } catch (e) {
            console.warn(`${EXT_NAME}: 读取 ${c.name} 聊天失败`, e);
        }
    }

    bar.style.width = '100%';
    renderCleanupResult(groups, cutoff);
    const total = groups.reduce((s, g) => s + g.chats.length, 0);
    status.textContent = `扫描完成：${groups.length} 个角色、共 ${total} 条聊天符合（最后时间早于 ${fmtDate(cutoff)}）`;
}

function renderCleanupResult(groups, cutoff) {
    const box = ui.cleanupResult;
    box.textContent = '';
    ui.cleanupBar.style.width = '0%';
    if (!groups.length) {
        box.append(el('div', { class: 'st-itk-hint', text: '没有符合条件的聊天记录。' }));
        return;
    }
    box.dataset.ready = '1';

    const chatRowRefs = [];

    for (const g of groups) {
        const groupCheck = el('input', { type: 'checkbox', checked: 'checked' });
        const subBox = el('div', { class: 'st-itk-sub' });
        const toggleBtn = el('button', {
            class: 'menu_button', type: 'button',
            text: '详情',
        });

        for (const ch of g.chats) {
            const isCurrent = (ch.file_id && ch.file_id === getContext().chatId);
            const check = el('input', { type: 'checkbox', disabled: isCurrent ? 'disabled' : null });
            if (!isCurrent) check.checked = true;
            const row = el('div', { class: `st-itk-item${isCurrent ? ' st-itk-disabled' : ''}` }, [
                check,
                el('span', { class: 'st-itk-name', text: String(ch.file_id || ch.file_name).replace('.jsonl', '') }),
                el('span', { class: 'st-itk-meta', text: `最后 ${fmtDate(ch.last_mes)} · ${ch.chat_items ?? '?'} 条 · ${ch.file_size || ''}` }),
                isCurrent ? el('span', { class: 'st-itk-badge', text: '当前聊天' }) : null,
            ]);
            chatRowRefs.push(check);
            subBox.append(row);
        }

        groupCheck.addEventListener('change', () => {
            subBox.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.disabled) cb.checked = groupCheck.checked;
            });
        });

        toggleBtn.addEventListener('click', () => {
            subBox.hidden = !subBox.hidden;
            toggleBtn.textContent = subBox.hidden ? '详情' : '收起';
        });
        subBox.hidden = true;

        box.append(el('div', { class: 'st-itk-item' }, [
            groupCheck,
            el('span', { class: 'st-itk-name', text: g.char.name }),
            el('span', { class: 'st-itk-meta', text: `最后聊天 ${fmtDate(g.char.date_last_chat)} · ${g.chats.length} 条 · ${fmtBytes(g.char.chat_size)}` }),
            el('div', { class: 'st-itk-sp' }, [toggleBtn]),
        ]));
        box.append(subBox);
    }

    box._collectChecked = () => {
        const targets = [];
        const items = box.querySelectorAll('.st-itk-sub .st-itk-item');
        // 聊天行与勾选组按 DOM 顺序一一对应
        let idx = 0;
        for (const g of groups) {
            for (const ch of g.chats) {
                const row = items[idx++];
                const cb = row && row.querySelector('input[type="checkbox"]');
                if (cb && cb.checked) targets.push({ avatar_url: g.char.avatar, chatfile: ch.file_name, file_id: ch.file_id, charName: g.char.name });
            }
        }
        return targets;
    };
    box._selectAll = (state) => {
        box.querySelectorAll('.st-itk-sub input[type="checkbox"]').forEach(cb => {
            if (!cb.disabled) cb.checked = state;
        });
        box.querySelectorAll(':scope > .st-itk-item input[type="checkbox"]').forEach(cb => cb.checked = state);
    };
    void cutoff;
}

async function deleteSelectedChats() {
    const box = ui.cleanupResult;
    if (box.dataset.ready !== '1' || typeof box._collectChecked !== 'function') {
        toast('warning', '请先扫描');
        return;
    }
    const targets = box._collectChecked();
    if (!targets.length) {
        toast('warning', '没有勾选任何聊天');
        return;
    }
    const ok = await confirmPopup(
        el('div', {}, [
            el('div', { text: `即将永久删除 ${targets.length} 条聊天记录，且不可恢复。` }),
            el('div', { class: 'st-itk-hint', text: '建议先用“导出/备份”功能自行备份。' }),
        ]),
        '删除',
    );
    if (!ok) return;

    let done = 0;
    let failed = 0;
    for (const t of targets) {
        ui.cleanupStatus.textContent = `正在删除 ${done + 1}/${targets.length}：${t.charName} / ${t.file_id}`;
        ui.cleanupBar.style.width = `${Math.round((done / targets.length) * 100)}%`;
        try {
            await apiPost('/api/chats/delete', { avatar_url: t.avatar_url, chatfile: t.chatfile });
            done++;
            try { await eventSource.emit(event_types.CHAT_DELETED, t.file_id); } catch { /* 忽略 */ }
        } catch (e) {
            failed++;
            console.warn(`${EXT_NAME}: 删除失败`, t, e);
        }
    }
    ui.cleanupBar.style.width = '100%';
    ui.cleanupStatus.textContent = `删除完成：成功 ${done} 条${failed ? `，失败 ${failed} 条` : ''}`;
    toast('success', `已删除 ${done} 条聊天记录`);
    box.textContent = '';
    box.dataset.ready = '0';
    ui.cleanupBar.style.width = '0%';
}

// ---------------------------------------------------------------------------
// Preset JSON 整理器
// ---------------------------------------------------------------------------

function organizePreset(rawText, indent) {
    let data;
    try {
        data = JSON.parse(rawText);
    } catch (e) {
        throw new Error(`JSON 解析失败：${e.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('顶层不是一个 JSON 对象');
    }
    if (!Array.isArray(data.prompts)) {
        throw new Error('没有找到 prompts 数组');
    }

    // 取出 prompt_order 的 identifier 顺序，支持 [{order:[...]}] 与 [{identifier}] 两种结构
    let orderIds = [];
    const po = data.prompt_order;
    if (Array.isArray(po)) {
        if (po.length && po[0] && Array.isArray(po[0].order)) {
            orderIds = po[0].order.map(x => (x && typeof x.identifier === 'string') ? x.identifier : null).filter(Boolean);
        } else {
            orderIds = po.map(x => (x && typeof x.identifier === 'string') ? x.identifier : null).filter(Boolean);
        }
    }
    if (!orderIds.length) {
        throw new Error('prompt_order 中没有可识别的 identifier 顺序');
    }

    // identifier → 队列，保留重复项与原始相对顺序
    const queues = new Map();
    for (const p of data.prompts) {
        const id = p && typeof p.identifier === 'string' ? p.identifier : null;
        if (id === null) continue;
        if (!queues.has(id)) queues.set(id, []);
        queues.get(id).push(p);
    }

    const out = [];
    for (const id of orderIds) {
        const q = queues.get(id);
        if (q && q.length) out.push(q.shift());
    }
    // 未进入顺序表的条目按原相对顺序补到末尾，无 identifier 的原样保留
    for (const p of data.prompts) {
        const id = p && typeof p.identifier === 'string' ? p.identifier : null;
        if (id === null) { out.push(p); continue; }
        const q = queues.get(id);
        if (q && q.length) out.push(q.shift());
    }

    data.prompts = out;
    return JSON.stringify(data, null, indent);
}

function downloadText(filename, text, mime = 'application/json') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast('success', '已复制到剪贴板');
    } catch {
        const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('success', '已复制到剪贴板');
    }
}

// ---------------------------------------------------------------------------
// 图片格式转换
// ---------------------------------------------------------------------------

async function convertOne(file, opts) {
    const dataUrl = await readFileAsDataURL(file);
    const img = await loadImageFromDataUrl(dataUrl);
    const w = Math.max(1, Math.round(img.naturalWidth * opts.scale));
    const h = Math.max(1, Math.round(img.naturalHeight * opts.scale));
    const canvas = el('canvas', { width: w, height: h });
    const ctx = canvas.getContext('2d');
    if (opts.format === 'image/jpeg') {
        ctx.fillStyle = '#ffffff'; // JPG 无透明通道，先铺白底
        ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('编码失败'))), opts.format, opts.quality);
    });
    const ext = opts.format === 'image/png' ? '.png' : '.jpg';
    const name = file.name.replace(/\.[^.]+$/, '') + ext;
    return {
        name,
        blob,
        width: w,
        height: h,
        url: URL.createObjectURL(blob),
        original: file.size,
    };
}

async function runConvert(files) {
    const opts = {
        format: ui.convertFormat.value,
        quality: Number(ui.convertQuality.value),
        scale: Number(ui.convertScale.value),
    };
    S().convert = { ...opts };
    persist();
    ui.convertResult.textContent = '';
    for (const file of files) {
        try {
            const r = await convertOne(file, opts);
            const item = el('div', { class: 'st-itk-item' }, [
                el('span', { class: 'st-itk-name', text: r.name }),
                el('span', { class: 'st-itk-meta', text: `${r.width}×${r.height} · ${fmtBytes(r.original)} → ${fmtBytes(r.blob.size)}` }),
                el('div', { class: 'st-itk-sp' }, [
                    el('button', {
                        class: 'menu_button', type: 'button', text: '下载',
                        onclick: () => {
                            const a = el('a', { href: r.url, download: r.name });
                            document.body.append(a);
                            a.click();
                            a.remove();
                        },
                    }),
                ]),
            ]);
            ui.convertResult.append(item);
        } catch (e) {
            ui.convertResult.append(el('div', { class: 'st-itk-item', text: `${file.name} 转换失败：${e.message}` }));
        }
    }
    toast('success', '转换完成');
}

// ---------------------------------------------------------------------------
// UI 构建（全部收纳式折叠面板，原生样式，自适应主题）
// ---------------------------------------------------------------------------

const ui = {};

function section(title, icon, buildBody, helpHtml) {
    const body = el('div', { class: 'st-itk-body', hidden: 'hidden' });
    const head = el('button', {
        class: 'st-itk-head', type: 'button', 'aria-expanded': 'false',
    }, [
        el('i', { class: icon }),
        el('span', { text: title }),
        el('i', { class: 'fa-solid fa-chevron-down st-itk-chev' }),
    ]);
    if (helpHtml) {
        const help = el('div', { class: 'st-itk-hint st-itk-help', hidden: 'hidden', html: helpHtml });
        const helpBtn = el('button', {
            class: 'st-itk-help-btn', type: 'button', title: '功能说明', text: '说明',
        });
        helpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            help.hidden = !help.hidden;
        });
        head.insertBefore(helpBtn, head.querySelector('.st-itk-chev'));
        body.append(help);
    }
    head.addEventListener('click', () => {
        const open = body.hidden;
        body.hidden = !open;
        head.setAttribute('aria-expanded', String(open));
    });
    buildBody(body);
    return el('div', { class: 'st-itk-section' }, [head, body]);
}

function filePicker(accept, multiple, onPick) {
    const input = el('input', {
        type: 'file', accept, hidden: 'hidden',
        ...(multiple ? { multiple: 'multiple' } : {}),
    });
    input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        if (files.length) onPick(files);
    });
    return input;
}

function buildImageListBody(body) {
    const list = el('div', { class: 'st-itk-list' });
    ui.imageList = list;

    const uploadInput = filePicker('image/*', true, async (files) => {
        const added = await addImages(files);
        if (added.length) toast('success', `已添加 ${added.length} 张图片`);
    });

    // 发送模式由用户按需选择
    const modeSelect = el('select', { class: 'text_pole', title: '发送图片 / 输出文字标记 / 停用宏输出' }, [
        el('option', { value: 'image', text: '发送图片' }),
        el('option', { value: 'text', text: '仅文字标记' }),
        el('option', { value: 'off', text: '停用宏输出' }),
    ]);
    modeSelect.value = S().images.mode || 'image';
    modeSelect.addEventListener('change', () => {
        S().images.mode = modeSelect.value;
        persist();
        toast('info', `图片发送模式：${modeSelect.selectedOptions[0].text}`);
    });

    const compressCheck = el('input', { type: 'checkbox' });
    compressCheck.checked = S().images.autoCompress;
    compressCheck.addEventListener('change', () => {
        S().images.autoCompress = compressCheck.checked;
        persist();
    });

    body.append(
        el('div', { class: 'st-itk-row' }, [
            el('button', { class: 'menu_button', type: 'button', text: '上传图片', onclick: () => uploadInput.click() }),
            uploadInput,
            el('label', { class: 'st-itk-check' }, [compressCheck, el('span', { text: '上传时自动压缩' })]),
            el('label', { class: 'st-itk-check' }, [el('span', { text: '发送模式' }), modeSelect]),
        ]),
        list,
    );
    renderImageList();
}

function renderImageList() {
    const list = ui.imageList;
    if (!list) return;
    list.textContent = '';
    const metas = S().imageMeta;
    if (!metas.length) {
        list.append(el('div', { class: 'st-itk-hint', text: '图片库为空。' }));
        return;
    }
    for (const meta of metas) {
        const entry = imageIndex.get(meta.name);
        const thumb = el('img', {
            class: 'st-itk-thumb', alt: meta.name, src: entry ? entry.dataUrl : '',
            title: '点击预览大图',
            style: { cursor: 'pointer' },
            onclick: () => entry && previewImage(entry.dataUrl, meta.name),
        });
        const row = el('div', { class: 'st-itk-item' }, [
            thumb,
            el('div', {}, [
                el('div', { class: 'st-itk-name', text: meta.name }),
                el('div', { class: 'st-itk-meta', text: `${meta.width || '?'}×${meta.height || '?'} · ${fmtBytes(meta.bytes)} · ${fmtDate(meta.created)}` }),
            ]),
            el('div', { class: 'st-itk-sp' }, [
                el('button', {
                    class: 'menu_button', type: 'button', text: '复制宏',
                    onclick: () => copyText(`{{img::${meta.name}}}`),
                }),
                el('button', {
                    class: 'menu_button', type: 'button', text: '改名',
                    onclick: async () => {
                        const popup = new Popup(el('div', {}, [el('div', { text: '新的图片名：' })]), POPUP_TYPE.INPUT, meta.name, { okButton: '确定', cancelButton: '取消' });
                        const res = await popup.show();
                        if (res === false || res === null || res === undefined) return;
                        const name = String(res).trim();
                        if (!name || name === meta.name) return;
                        if (imageIndex.has(name)) { toast('error', '已存在同名图片'); return; }
                        unindexImage(meta.name);
                        meta.name = name;
                        const dataUrl = await idbGet(meta.id);
                        if (dataUrl) indexImage(meta, dataUrl);
                        persist();
                        renderImageList();
                    },
                }),
                el('button', {
                    class: 'menu_button', type: 'button', text: '删除',
                    onclick: async () => {
                        const ok = await confirmPopup(el('div', { text: `删除图片「${meta.name}」？` }), '删除');
                        if (ok) await removeImage(meta);
                    },
                }),
            ]),
        ]);
        list.append(row);
    }
}

function buildImageBody(body) {
    buildImageListBody(body);
}

function buildCleanupBody(body) {
    const daysInput = el('input', { class: 'text_pole st-itk-num', type: 'number', min: '0', value: String(S().cleanup.days ?? 30) });
    daysInput.addEventListener('change', () => {
        S().cleanup.days = Math.max(0, Number(daysInput.value) || 0);
        persist();
    });
    const modeSel = el('select', { class: 'text_pole' }, [
        el('option', { value: 'character', text: '按角色最后聊天时间' }),
        el('option', { value: 'chat', text: '按每条聊天最后消息时间' }),
    ]);
    modeSel.value = S().cleanup.mode || 'character';
    modeSel.addEventListener('change', () => {
        S().cleanup.mode = modeSel.value;
        persist();
    });

    const scanBtn = el('button', { class: 'menu_button', type: 'button', text: '扫描' });
    const status = el('div', { class: 'st-itk-status', text: '' });
    const bar = el('div', {}, [el('div', {})]);
    bar.className = 'st-itk-progress';
    const result = el('div', { class: 'st-itk-list' });
    ui.cleanupStatus = status;
    ui.cleanupBar = bar.firstChild;
    ui.cleanupResult = result;

    scanBtn.addEventListener('click', () => scanOldChats().catch(e => {
        console.error(EXT_NAME, e);
        status.textContent = `扫描失败：${e.message}`;
    }));

    body.append(
        el('div', { class: 'st-itk-row' }, [
            el('label', { class: 'st-itk-check' }, [el('span', { text: '距今 ≥' }), daysInput, el('span', { text: '天' })]),
            modeSel,
            scanBtn,
        ]),
        bar,
        status,
        result,
        el('div', { class: 'st-itk-row' }, [
            el('button', { class: 'menu_button', type: 'button', text: '全选', onclick: () => result._selectAll && result._selectAll(true) }),
            el('button', { class: 'menu_button', type: 'button', text: '全不选', onclick: () => result._selectAll && result._selectAll(false) }),
            el('button', { class: 'menu_button', type: 'button', text: '删除所选聊天', onclick: () => deleteSelectedChats().catch(e => toast('error', e.message)) }),
        ]),
    );
}

function buildPresetBody(body) {
    // JSON 预览框：可直接编辑
    const input = el('textarea', {
        class: 'text_pole st-itk-panel-textarea st-itk-json-box',
        placeholder: 'JSON 内容全部显示在这里，可直接编辑；或点“上传文件”载入 .json',
    });
    // 整理预览框：整理后显示
    const output = el('textarea', {
        class: 'text_pole st-itk-panel-textarea st-itk-json-box',
        placeholder: '整理结果', readonly: 'readonly',
    });
    const outputWrap = el('div', { hidden: 'hidden' }, [output]);
    const status = el('span', { class: 'st-itk-status' });
    ui.presetInput = input;
    ui.presetOutput = output;
    ui.presetStatus = status;
    let organized = false;

    const fileInput = filePicker('.json,application/json', false, async (files) => {
        try {
            input.value = await files[0].text();
            organized = false;
            outputWrap.hidden = true;
            status.textContent = `已载入：${files[0].name}（${fmtBytes(files[0].size)}）`;
        } catch (e) {
            status.textContent = `读取失败：${e.message}`;
        }
    });

    // ---- 查找 / 替换 ----
    const findInput = el('input', { class: 'text_pole st-itk-grow', type: 'text', placeholder: '查找内容（回车=查找下一处）' });
    const replInput = el('input', { class: 'text_pole st-itk-grow', type: 'text', placeholder: '替换成' });

    function findNext() {
        const q = findInput.value;
        if (!q) { status.textContent = '输入查找内容'; return; }
        const text = input.value;
        const from = Math.max(input.selectionEnd ?? 0, 0);
        let idx = text.indexOf(q, from);
        if (idx < 0) idx = text.indexOf(q); // 回绕到开头
        if (idx < 0) { status.textContent = '未找到'; return; }
        input.focus();
        input.setSelectionRange(idx, idx + q.length);
        scrollTextareaTo(input, idx);
        status.textContent = `命中 #${text.slice(0, idx).split(q).length} · 位置 ${idx}`;
    }
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); findNext(); }
    });

    function replaceOne() {
        const q = findInput.value;
        if (!q) { status.textContent = '输入查找内容'; return; }
        const selStart = input.selectionStart ?? 0;
        const selEnd = input.selectionEnd ?? 0;
        if (input.value.slice(selStart, selEnd) === q) {
            input.setRangeText(replInput.value, selStart, selEnd, 'end');
            status.textContent = '已替换 1 处，继续查找下一处';
        }
        findNext();
    }

    function replaceAll() {
        const q = findInput.value;
        if (!q) { status.textContent = '输入查找内容'; return; }
        const count = input.value.split(q).length - 1;
        if (!count) { status.textContent = '未找到'; return; }
        input.value = input.value.split(q).join(replInput.value);
        status.textContent = `已全部替换 ${count} 处`;
    }

    // ---- 整理 ----
    const organizeBtn = el('button', { class: 'menu_button', type: 'button', text: '整理' });
    organizeBtn.addEventListener('click', () => {
        const raw = input.value.trim();
        if (!raw) { status.textContent = '没有可整理的内容'; toast('warning', '请先上传或粘贴 JSON'); return; }
        try {
            output.value = organizePreset(raw, 4);
            outputWrap.hidden = false;
            organized = true;
            status.textContent = `整理完成：${JSON.parse(output.value).prompts.length} 个 prompt 已按 prompt_order 重排`;
            toast('success', '整理完成');
        } catch (e) {
            status.textContent = e.message;
            toast('error', e.message);
        }
    });

    // ---- 功能说明（收纳）----
    const helpText = el('div', {
        class: 'st-itk-hint st-itk-help', hidden: 'hidden',
        html: '整理：按 <span class="st-itk-mono">prompt_order</span> 的 ID 顺序重排 <span class="st-itk-mono">prompts</span> 数组，其他任何数据（含字段顺序）原样保留。<br>查找/替换：直接编辑上方 JSON；查找框回车 = 查找下一处并高亮定位，替换 = 替换当前命中并跳下一处，全部替换 = 一次替换所有。<br>导出：未整理时导出上方编辑框内容，整理后导出下方整理结果。',
    });
    const helpBtn = el('button', { class: 'menu_button', type: 'button', text: '功能说明' });
    helpBtn.addEventListener('click', () => { helpText.hidden = !helpText.hidden; });

    // ---- 导出 ----
    const exportBtn = el('button', {
        class: 'menu_button', type: 'button', text: '导出',
        onclick: () => {
            const text = organized ? output.value : input.value;
            if (!text.trim()) { toast('warning', '没有可导出的内容'); return; }
            downloadText(organized ? 'preset-organized.json' : 'preset.json', text);
        },
    });

    body.append(
        el('div', { class: 'st-itk-row' }, [
            el('button', { class: 'menu_button', type: 'button', text: '上传文件', onclick: () => fileInput.click() }),
            fileInput,
        ]),
        input,
        el('div', { class: 'st-itk-row' }, [findInput, replInput]),
        el('div', { class: 'st-itk-row' }, [
            el('button', { class: 'menu_button', type: 'button', text: '替换', onclick: replaceOne }),
            el('button', { class: 'menu_button', type: 'button', text: '全部替换', onclick: replaceAll }),
            status,
        ]),
        el('div', { class: 'st-itk-row' }, [organizeBtn, helpBtn]),
        helpText,
        outputWrap,
        el('div', { class: 'st-itk-row' }, [exportBtn]),
    );
}

function buildConvertBody(body) {
    const formatSel = el('select', { class: 'text_pole' }, [
        el('option', { value: 'image/jpeg', text: 'JPG' }),
        el('option', { value: 'image/png', text: 'PNG' }),
    ]);
    formatSel.value = S().convert.format || 'image/jpeg';
    const quality = el('input', { class: 'st-itk-range', type: 'range', min: '0.1', max: '1', step: '0.05', value: String(S().convert.quality ?? 0.85) });
    const qualityVal = el('span', { class: 'st-itk-meta', text: quality.value });
    const scale = el('input', { class: 'st-itk-range', type: 'range', min: '0.1', max: '1', step: '0.05', value: String(S().convert.scale ?? 1) });
    const scaleVal = el('span', { class: 'st-itk-meta', text: `${Math.round(Number(scale.value) * 100)}%` });
    quality.addEventListener('input', () => { qualityVal.textContent = quality.value; });
    scale.addEventListener('input', () => { scaleVal.textContent = `${Math.round(Number(scale.value) * 100)}%`; });

    const result = el('div', { class: 'st-itk-list' });
    ui.convertFormat = formatSel;
    ui.convertQuality = quality;
    ui.convertScale = scale;
    ui.convertResult = result;

    const fileInput = filePicker('image/*', true, (files) => runConvert(files).catch(e => toast('error', e.message)));

    body.append(
        el('div', { class: 'st-itk-row' }, [
            el('button', { class: 'menu_button', type: 'button', text: '选择图片', onclick: () => fileInput.click() }),
            fileInput,
            el('label', { class: 'st-itk-check' }, [el('span', { text: '格式' }), formatSel]),
        ]),
        el('div', { class: 'st-itk-row' }, [
            el('span', { text: '质量', class: 'st-itk-meta' }),
            quality, qualityVal,
            el('span', { text: '缩放', class: 'st-itk-meta' }),
            scale, scaleVal,
        ]),
        result,
    );
}

function buildUi() {
    if (document.getElementById('st-itk-panel')) return;
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) {
        console.warn(`${EXT_NAME}: 未找到扩展设置容器`);
        return;
    }

    // 四个功能区，默认收纳
    const inner = el('div', { class: 'st-itk-body', hidden: 'hidden' }, [
        section('聊天记录清理', 'fa-solid fa-broom', buildCleanupBody,
            '扫描最后聊天时间早于 N 天的角色卡及其聊天记录，勾选后批量删除。<b>当前打开的聊天会自动跳过</b>；删除不可恢复，建议先自行备份。支持按“角色最后聊天时间”或“每条聊天最后消息时间”两种口径过滤。'),
        section('图片插入（宏）', 'fa-solid fa-image', buildImageBody,
            '上传图片后点“复制宏”得到 <span class="st-itk-mono">{{img::图片名}}</span>，粘贴到<b>世界书 / 角色描述 / 预设提示词 / 聊天</b>任意位置。请求发出时宏解析为和 ST 原生图片附件一样的图片内容块，base64 不进正文、不占文本 token，一张图按图片计费（约几百 token）。「发送模式」：<b>发送图片</b>（默认，直接发送图片内容块）、<b>输出文字标记</b>（输出 [图片: 名称]，适合纯文本模型）、<b>停用宏输出</b>（输出为空）。纯文本补全 API 不承载图片，统一以文字标记呈现。<b>点击缩略图可预览大图</b>。'),
        section('Preset JSON 整理器', 'fa-solid fa-list-ordered', buildPresetBody),
        section('图片格式转换', 'fa-solid fa-file-image', buildConvertBody,
            'JPG / PNG 互转。质量调节对 JPG 有效（PNG 为无损格式）；缩放对两者都有效。透明背景转 JPG 会自动铺白底。'),
    ]);

    // 顶部收纳按钮：展开 / 收起面板
    const topHead = el('button', {
        class: 'st-itk-head st-itk-top', type: 'button', 'aria-expanded': 'false',
    }, [
        el('i', { class: 'fa-solid fa-toolbox' }),
        el('span', { text: EXT_NAME }),
        el('span', { class: 'st-itk-ver', text: '2.3.0' }),
        el('i', { class: 'fa-solid fa-chevron-down st-itk-chev' }),
    ]);
    topHead.addEventListener('click', () => {
        const open = inner.hidden;
        inner.hidden = !open;
        topHead.setAttribute('aria-expanded', String(open));
    });

    const panel = el('div', { id: 'st-itk-panel' }, [topHead, inner]);
    container.append(panel);
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

let inited = false;

async function init() {
    if (inited) return;
    inited = true;
    S();

    // 图片库载入内存，作为宏的数据源
    try {
        for (const meta of S().imageMeta.slice()) {
            const dataUrl = await idbGet(meta.id);
            if (dataUrl) indexImage(meta, dataUrl);
        }
    } catch (e) {
        console.warn(`${EXT_NAME}: 图片库载入失败`, e);
    }

    // 注册图片宏
    await registerImageMacro();

    // 挂接请求流水线
    hookRequestPipeline();

    // 构建设置面板
    buildUi();
    eventSource.on(event_types.APP_READY, () => buildUi());
    eventSource.on(event_types.SETTINGS_LOADED, () => { S(); });
    console.log(`${EXT_NAME}: 初始化完成`);
}

// 启动入口：manifest hooks.activate 与页面就绪后都会触发，init 幂等
export { init };
jQuery(() => setTimeout(() => init().catch(e => console.error(EXT_NAME, e)), 0));
