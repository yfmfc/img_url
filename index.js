/**
 * Image Toolkit —— SillyTavern 功能扩展
 *
 * 功能：
 *   1. 聊天记录清理：按“最后聊天时间距今 N 天”扫描角色卡并批量删除聊天
 *   2. 图片插入：
 *      - 图片库 + 宏 {{img::图片名}}：放在任意位置（世界书/角色描述/预设/聊天），
 *        发送请求时自动替换为真正的图片内容（随请求发给多模态 API）
 *      - 预处理注入：像世界书一样选择插入位置/深度/角色 + 文字描述
 *   3. Preset JSON 整理器：按 prompt_order 的顺序重排 prompts 数组，其余原样保留
 *   4. 图片格式转换：JPG / PNG 互转 + 手动质量/缩放压缩
 *
 * 不做独立悬浮窗，面板挂载在 SillyTavern 自带的扩展设置抽屉里，
 * 全部控件使用 SillyTavern 原生样式类 + 主题变量，自动跟随用户主题。
 */

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    getRequestHeaders,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';

// ---------------------------------------------------------------------------
// 常量 & 设置
// ---------------------------------------------------------------------------

const EXT_NAME = 'Image Toolkit';
const EXT_ID = 'stImageToolkit';
const MACRO_NAME = 'img';
const INJECT_PREFIX = 'stItkImg_';
const DB_NAME = 'st-image-toolkit';
const DB_STORE = 'images';

const DEFAULT_SETTINGS = {
    images: {
        enabled: true,          // 宏替换总开关
        autoCompress: true,     // 上传时自动压缩
        maxEdge: 1280,          // 自动压缩最长边
        quality: 0.85,          // 自动压缩质量
    },
    imageMeta: [],              // [{id, name, mime, bytes, width, height, created}]
    injections: [],             // [{id, imageId, name, caption, position, depth, scan, role, enabled}]
    cleanup: {
        days: 30,
        mode: 'character',      // character | chat
    },
    convert: {
        format: 'image/jpeg',
        quality: 0.85,
        scale: 1,
    },
};

/** 保证 extension_settings.imageToolkit 存在且字段齐全（设置被外部覆盖也能自愈） */
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
// IndexedDB：图片本体存储（不塞 localStorage，避免配额爆掉）
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

/** name -> {id, name, dataUrl} */
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
            if (typeof legacyMacros?.syncImageMacros === 'function') legacyMacros.syncImageMacros();
            added.push(meta);
        } catch (e) {
            console.error(EXT_NAME, e);
            toast('error', `${file.name} 处理失败：${e.message}`);
        }
    }
    persist();
    renderImageList();
    renderInjectionControls();
    return added;
}

async function removeImage(meta) {
    unindexImage(meta.name);
    try { legacyMacros?.unregisterMacro?.(`${MACRO_NAME}::${meta.name}`); } catch { /* ignore */ }
    await idbDelete(meta.id).catch(() => {});
    S().imageMeta = S().imageMeta.filter(x => x.id !== meta.id);
    S().injections = S().injections.filter(x => x.imageId !== meta.id);
    persist();
    applyInjections();
    renderImageList();
    renderInjectionControls();
    renderInjectionList();
}

// ---------------------------------------------------------------------------
// 宏系统：{{img::图片名}} → <img src="data:...">
// ---------------------------------------------------------------------------

let macrosApi = null;      // 新版宏引擎 (macros/macro-system.js)
let legacyMacros = null;   // 旧版 MacrosParser 兜底

function buildImgTag(name) {
    if (S().images.enabled === false) return '';
    const key = String(name || '').trim();
    const entry = imageIndex.get(key);
    if (!entry) {
        console.warn(`${EXT_NAME}: 未找到图片 "${key}"`);
        return '';
    }
    return `<img src="${entry.dataUrl}" alt="${key}">`;
}

function registerMacro() {
    const argDef = [{ name: 'name', optional: false, sampleValue: '角色立绘', description: '图片库中的图片名' }];
    if (macrosApi && typeof macrosApi.register === 'function') {
        try {
            macrosApi.register(MACRO_NAME, {
                category: macrosApi.category?.CORE ?? 'core',
                description: '把图片库中的图片注入到提示词（请求发出时替换为图片内容）',
                displayOverride: '{{img::图片名}}',
                exampleUsage: ['{{img::角色立绘}}'],
                unnamedArgs: argDef,
                handler: (ctx) => buildImgTag(ctx?.unnamedArgs?.[0] ?? ctx?.args?.[0] ?? ''),
            });
            console.log(`${EXT_NAME}: 已注册宏 {{img::图片名}}`);
            return;
        } catch (e) {
            console.warn(`${EXT_NAME}: 新版宏注册失败，尝试旧版`, e);
        }
    }
    if (legacyMacros && typeof legacyMacros.registerMacro === 'function') {
        // 旧版引擎：为每张图片注册精确宏 {{img::名称}}
        const sync = () => {
            for (const [name, entry] of imageIndex) {
                try { legacyMacros.registerMacro(`${MACRO_NAME}::${name}`, `<img src="${entry.dataUrl}" alt="${name}">`); } catch { /* ignore */ }
            }
        };
        sync();
        legacyMacros.syncImageMacros = sync;
        console.log(`${EXT_NAME}: 已按旧版宏引擎注册图片宏`);
    }
}

// ---------------------------------------------------------------------------
// 请求拦截：把提示词里的 <img src="data:..."> 真正变成 API 的图片内容
// （SillyTavern 服务端原生支持 image_url 内容块，可自动转换到 Claude/Gemini/OpenRouter 等）
// ---------------------------------------------------------------------------

const IMG_TAG_RE = /<img\b[^>]*?\bsrc\s*=\s*["'](data:image\/[^"']+)["'][^>]*>/gi;

function getAlt(tagHtml) {
    const m = /\balt\s*=\s*["']([^"']*)["']/i.exec(tagHtml);
    return m ? m[1] : '';
}

function mergeTextParts(parts) {
    const out = [];
    for (const p of parts) {
        const last = out[out.length - 1];
        if (p.type === 'text' && last && last.type === 'text') last.text += p.text;
        else out.push(p);
    }
    return out.filter(p => p.type !== 'text' || p.text.length);
}

/** 文本 → [text, image_url, text, ...]；没有图片标记时返回 null */
function splitTextWithImages(text) {
    if (typeof text !== 'string' || !text.includes('data:image/')) return null;
    const parts = [];
    const re = new RegExp(IMG_TAG_RE.source, 'gi');
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
        parts.push({ type: 'image_url', image_url: { url: m[1] } });
        last = m.index + m[0].length;
    }
    if (!parts.length) return null;
    if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
    return mergeTextParts(parts);
}

/** 非多模态场景：把 img 标签替换成 alt 文本，避免 base64 污染提示词 */
function stripImagesToAlt(text) {
    return text.replace(new RegExp(IMG_TAG_RE.source, 'gi'), (_m, _src, ...rest) => {
        const tag = _m;
        const alt = getAlt(tag);
        return alt ? `[图片: ${alt}]` : '';
    });
}

function transformContent(content) {
    if (typeof content === 'string') return splitTextWithImages(content);
    if (Array.isArray(content)) {
        let changed = false;
        const out = [];
        for (const part of content) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
                const split = splitTextWithImages(part.text);
                if (split) { out.push(...split); changed = true; continue; }
            }
            out.push(part);
        }
        return changed ? out : null;
    }
    return null;
}

let openaiMod = null; // 用于读取 ST 自带的“媒体内联”状态

function imagesAllowedNow() {
    try {
        if (typeof openaiMod?.isImageInliningSupported === 'function') {
            return !!openaiMod.isImageInliningSupported();
        }
    } catch { /* ignore */ }
    return true;
}

function patchFetch() {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const body = init && typeof init.body === 'string' ? init.body : null;
            if (body && body.includes('data:image/') && S().images.enabled) {
                const isChatCompletion = url.includes('/api/chat-completion');
                const isTextGen = url.includes('text-completions') || url.includes('/api/ai/');
                if (isChatCompletion || isTextGen) {
                    let data;
                    try { data = JSON.parse(body); } catch { data = null; }
                    if (data) {
                        let touched = false;
                        const imagesOk = imagesAllowedNow();
                        if (isChatCompletion && Array.isArray(data.messages)) {
                            for (const msg of data.messages) {
                                if (!msg) continue;
                                const result = imagesOk ? transformContent(msg.content) : null;
                                if (result) {
                                    msg.content = result;
                                    touched = true;
                                } else if (!imagesOk && typeof msg.content === 'string' && msg.content.includes('data:image/')) {
                                    msg.content = stripImagesToAlt(msg.content);
                                    touched = true;
                                }
                            }
                        } else if (isTextGen) {
                            for (const key of ['prompt', 'quiet_prompt', 'instruction', 'negative_prompt', 'memory']) {
                                if (typeof data[key] === 'string' && data[key].includes('data:image/')) {
                                    data[key] = stripImagesToAlt(data[key]);
                                    touched = true;
                                }
                            }
                        }
                        if (touched) {
                            init = { ...init, body: JSON.stringify(data) };
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`${EXT_NAME}: 请求改写失败（已原样发送）`, e);
        }
        return origFetch(input, init);
    };
}

// ---------------------------------------------------------------------------
// 预处理注入（设想1）：位置 / 深度 / 角色，同世界书的插入方式
// ---------------------------------------------------------------------------

function injectionKey(id) {
    return `${INJECT_PREFIX}${id}`;
}

function applyInjections() {
    for (const inj of S().injections) {
        const content = inj.enabled ? composeInjectionContent(inj) : '';
        try {
            setExtensionPrompt(
                injectionKey(inj.id),
                content,
                Number(inj.position),
                Number(inj.depth),
                !!inj.scan,
                Number(inj.role),
            );
        } catch (e) {
            console.warn(`${EXT_NAME}: 注入失败`, inj.name, e);
        }
    }
}

function composeInjectionContent(inj) {
    const entry = imageIndexByImageId(inj.imageId);
    const parts = [];
    if (entry) parts.push(`<img src="${entry.dataUrl}" alt="${inj.name || entry.name}">`);
    if (inj.caption && String(inj.caption).trim()) parts.push(String(inj.caption).trim());
    return parts.join('\n');
}

function imageIndexByImageId(id) {
    for (const entry of imageIndex.values()) {
        if (entry.id === id) return entry;
    }
    return null;
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
        if (!c || !c.avatar || !Number(c.date_last_chat)) return false; // 没有聊天的角色
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
        // 每个聊天行与 group 顺序对应：通过 DOM 内容回查
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
            try { await eventSource.emit(event_types.CHAT_DELETED, t.file_id); } catch { /* ignore */ }
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

    // 取出 prompt_order 的 identifier 顺序（兼容 [{order:[...]}] 与 [{identifier}] 两种结构）
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

    // identifier → 队列（保留重复项与原始相对顺序）
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
    // 剩下的（不在 order 里的 / 重复的）按原顺序补到末尾；无 identifier 的原样保留
    for (const p of data.prompts) {
        const id = p && typeof p.identifier === 'string' ? p.identifier : null;
        if (id === null) { out.push(p); continue; }
        const q = queues.get(id);
        if (q && q.length) out.push(q.shift());
    }

    data.prompts = out;
    return JSON.stringify(data, null, indent);
}

function doOrganizePreset() {
    const raw = ui.presetInput.value.trim();
    if (!raw) {
        toast('warning', '请先粘贴或选择 Preset JSON');
        return;
    }
    try {
        const indent = Number(ui.presetIndent.value) || 2;
        ui.presetOutput.value = organizePreset(raw, indent);
        ui.presetStatus.textContent = `整理完成：${JSON.parse(ui.presetOutput.value).prompts.length} 个 prompt 已按 prompt_order 重排`;
        toast('success', '整理完成');
    } catch (e) {
        ui.presetStatus.textContent = e.message;
        toast('error', e.message);
    }
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

function section(title, icon, buildBody) {
    const body = el('div', { class: 'st-itk-body', hidden: 'hidden' });
    const head = el('button', {
        class: 'st-itk-head', type: 'button', 'aria-expanded': 'false',
    }, [
        el('i', { class: icon }),
        el('span', { text: title }),
        el('i', { class: 'fa-solid fa-chevron-down st-itk-chev' }),
    ]);
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

    const enabledCheck = el('input', { type: 'checkbox' });
    enabledCheck.checked = S().images.enabled;
    enabledCheck.addEventListener('change', () => {
        S().images.enabled = enabledCheck.checked;
        persist();
        toast('info', enabledCheck.checked ? '宏替换已启用' : '宏替换已停用');
    });

    const compressCheck = el('input', { type: 'checkbox' });
    compressCheck.checked = S().images.autoCompress;
    compressCheck.addEventListener('change', () => {
        S().images.autoCompress = compressCheck.checked;
        persist();
    });

    body.append(
        el('div', { class: 'st-itk-hint', html: '上传的图片可以用宏 <span class="st-itk-mono">{{img::图片名}}</span> 放进<b>世界书 / 角色描述 / 预设提示词 / 聊天</b>任意位置。发送请求时自动替换为真正的图片内容（支持视觉模型；Claude / Gemini / OpenRouter 等会自动转换）。' }),
        el('div', { class: 'st-itk-row' }, [
            el('button', { class: 'menu_button', type: 'button', text: '上传图片', onclick: () => uploadInput.click() }),
            uploadInput,
            el('label', { class: 'st-itk-check' }, [compressCheck, el('span', { text: '上传时自动压缩' })]),
            el('label', { class: 'st-itk-check' }, [enabledCheck, el('span', { text: '启用宏替换' })]),
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
        const thumb = el('img', { class: 'st-itk-thumb', alt: meta.name, src: entry ? entry.dataUrl : '' });
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
                        const oldName = meta.name;
                        meta.name = name;
                        const dataUrl = await idbGet(meta.id);
                        if (dataUrl) indexImage(meta, dataUrl);
                        try {
                            legacyMacros?.unregisterMacro?.(`${MACRO_NAME}::${oldName}`);
                            if (typeof legacyMacros?.syncImageMacros === 'function') legacyMacros.syncImageMacros();
                        } catch { /* ignore */ }
                        persist();
                        renderImageList();
                        renderInjectionControls();
                        renderInjectionList();
                    },
                }),
                el('button', {
                    class: 'menu_button', type: 'button', text: '删除',
                    onclick: async () => {
                        const ok = await confirmPopup(el('div', { text: `删除图片「${meta.name}」？相关注入也会被移除。` }), '删除');
                        if (ok) await removeImage(meta);
                    },
                }),
            ]),
        ]);
        list.append(row);
    }
}

function buildInjectionBody(body) {
    const imgSel = el('select', { class: 'text_pole st-itk-grow' });
    const caption = el('textarea', { class: 'text_pole st-itk-panel-textarea', placeholder: '图片搭配的文字描述（可选，会与图片一起插入）' });
    const posSel = el('select', { class: 'text_pole' }, [
        el('option', { value: String(extension_prompt_types.IN_CHAT), text: '聊天内（按深度插入）' }),
        el('option', { value: String(extension_prompt_types.IN_PROMPT), text: '主提示词内' }),
        el('option', { value: String(extension_prompt_types.BEFORE_PROMPT), text: '主提示词前' }),
    ]);
    const depthInput = el('input', { class: 'text_pole st-itk-num', type: 'number', min: '0', max: '99', value: '4' });
    const roleSel = el('select', { class: 'text_pole' }, [
        el('option', { value: String(extension_prompt_roles.SYSTEM), text: 'system' }),
        el('option', { value: String(extension_prompt_roles.USER), text: 'user' }),
        el('option', { value: String(extension_prompt_roles.ASSISTANT), text: 'assistant' }),
    ]);
    const scanCheck = el('input', { type: 'checkbox' });
    const addBtn = el('button', { class: 'menu_button', type: 'button', text: '添加注入' });
    const list = el('div', { class: 'st-itk-list' });

    ui.injectImgSel = imgSel;
    ui.injectCaption = caption;
    ui.injectPosSel = posSel;
    ui.injectDepth = depthInput;
    ui.injectRole = roleSel;
    ui.injectScan = scanCheck;
    ui.injectAddBtn = addBtn;
    ui.injectList = list;

    addBtn.addEventListener('click', () => {
        const imageId = imgSel.value;
        if (!imageId) { toast('warning', '请先上传并选择图片'); return; }
        const entry = imageIndexByImageId(imageId);
        const inj = {
            id: uid(),
            imageId,
            name: entry ? entry.name : '图片',
            caption: caption.value,
            position: Number(posSel.value),
            depth: Number(depthInput.value) || 0,
            scan: scanCheck.checked,
            role: Number(roleSel.value),
            enabled: true,
        };
        S().injections.push(inj);
        persist();
        applyInjections();
        renderInjectionList();
        toast('success', `已添加注入：${inj.name}`);
    });

    body.append(
        el('div', { class: 'st-itk-hint', text: '像世界书一样选择插入位置/深度/角色，把图片 + 描述注入到提示词结构里（适合固定的形象设定）。若想手动控制位置，请改用宏。' }),
        el('div', { class: 'st-itk-row' }, [
            imgSel,
            posSel,
            el('label', { class: 'st-itk-check' }, [el('span', { text: '深度' }), depthInput]),
            el('label', { class: 'st-itk-check' }, [el('span', { text: '角色' }), roleSel]),
            el('label', { class: 'st-itk-check' }, [scanCheck, el('span', { text: '参与WI扫描' })]),
            addBtn,
        ]),
        caption,
        list,
    );
    renderInjectionControls();
    renderInjectionList();
}

function renderInjectionControls() {
    const sel = ui.injectImgSel;
    if (!sel) return;
    const current = sel.value;
    sel.textContent = '';
    sel.append(el('option', { value: '', text: '— 选择图片 —' }));
    for (const meta of S().imageMeta) {
        sel.append(el('option', { value: meta.id, text: meta.name }));
    }
    if (current && S().imageMeta.some(x => x.id === current)) sel.value = current;
}

function renderInjectionList() {
    const list = ui.injectList;
    if (!list) return;
    list.textContent = '';
    const injections = S().injections;
    if (!injections.length) {
        list.append(el('div', { class: 'st-itk-hint', text: '暂无注入项。' }));
        return;
    }
    const posLabel = (p) => ({
        [extension_prompt_types.IN_CHAT]: '聊天内',
        [extension_prompt_types.IN_PROMPT]: '主提示词内',
        [extension_prompt_types.BEFORE_PROMPT]: '主提示词前',
    })[p] ?? String(p);
    for (const inj of injections) {
        const toggleBtn = el('button', {
            class: 'menu_button', type: 'button', text: inj.enabled ? '停用' : '启用',
        });
        toggleBtn.addEventListener('click', () => {
            inj.enabled = !inj.enabled;
            persist();
            applyInjections();
            renderInjectionList();
        });
        list.append(el('div', { class: `st-itk-item${inj.enabled ? '' : ' st-itk-disabled'}` }, [
            el('div', {}, [
                el('div', { class: 'st-itk-name', text: `${inj.name}${inj.caption ? ' + 文字描述' : ''}` }),
                el('div', { class: 'st-itk-meta', text: `${posLabel(inj.position)} · 深度 ${inj.depth} · ${['system', 'user', 'assistant'][inj.role] || inj.role}${inj.scan ? ' · WI扫描' : ''}` }),
            ]),
            el('div', { class: 'st-itk-sp' }, [
                toggleBtn,
                el('button', {
                    class: 'menu_button', type: 'button', text: '删除',
                    onclick: async () => {
                        const ok = await confirmPopup(el('div', { text: `删除注入「${inj.name}」？` }), '删除');
                        if (!ok) return;
                        try { setExtensionPrompt(injectionKey(inj.id), '', 0, 0, false, extension_prompt_roles.SYSTEM); } catch { /* ignore */ }
                        S().injections = S().injections.filter(x => x.id !== inj.id);
                        persist();
                        renderInjectionList();
                    },
                }),
            ]),
        ]));
    }
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
        el('div', { class: 'st-itk-hint', text: '扫描最后聊天时间早于 N 天的角色卡及其聊天记录，勾选后批量删除。当前打开的聊天不会被删除。删除不可恢复，谨慎操作。' }),
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
    const input = el('textarea', { class: 'text_pole st-itk-panel-textarea tall', placeholder: '在此粘贴原始 Preset JSON，或点击“选择 .json 文件”上传' });
    const output = el('textarea', { class: 'text_pole st-itk-panel-textarea tall', placeholder: '整理结果会显示在这里' });
    const indentSel = el('select', { class: 'text_pole' }, [
        el('option', { value: '2', text: '缩进 2 空格' }),
        el('option', { value: '4', text: '缩进 4 空格' }),
        el('option', { value: '0', text: '紧凑（不换行）' }),
    ]);
    const status = el('div', { class: 'st-itk-status' });
    ui.presetInput = input;
    ui.presetOutput = output;
    ui.presetIndent = indentSel;
    ui.presetStatus = status;

    const fileInput = filePicker('.json,application/json', false, async (files) => {
        try {
            input.value = await files[0].text();
            status.textContent = `已载入：${files[0].name}（${fmtBytes(files[0].size)}）`;
        } catch (e) {
            status.textContent = `读取失败：${e.message}`;
        }
    });

    body.append(
        el('div', { class: 'st-itk-hint', html: '只做一件事：按 <span class="st-itk-mono">prompt_order</span> 的 ID 顺序重排 <span class="st-itk-mono">prompts</span> 数组，其他任何数据（含字段顺序）原样保留。' }),
        el('div', { class: 'st-itk-row' }, [
            el('button', { class: 'menu_button', type: 'button', text: '选择 .json 文件', onclick: () => fileInput.click() }),
            fileInput,
            indentSel,
            el('button', { class: 'menu_button', type: 'button', text: '整理', onclick: doOrganizePreset }),
            el('button', { class: 'menu_button', type: 'button', text: '复制结果', onclick: () => output.value && copyText(output.value) }),
            el('button', {
                class: 'menu_button', type: 'button', text: '导出 .json',
                onclick: () => {
                    if (!output.value) { toast('warning', '没有可导出的结果'); return; }
                    downloadText('preset-organized.json', output.value);
                },
            }),
        ]),
        status,
        input,
        output,
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
        el('div', { class: 'st-itk-hint', text: 'JPG / PNG 互转。质量调节对 JPG 有效（PNG 为无损格式）；缩放对两者都有效。' }),
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
    const panel = el('div', { id: 'st-itk-panel' }, [
        el('div', { class: 'st-itk-title' }, [
            el('i', { class: 'fa-solid fa-toolbox' }),
            el('span', { text: EXT_NAME }),
            el('span', { class: 'st-itk-ver', text: 'v1.0.0' }),
        ]),
        section('聊天记录清理', 'fa-solid fa-broom', buildCleanupBody),
        section('图片库 / 宏 {{img::名称}}', 'fa-solid fa-image', buildImageListBody),
        section('图片注入（预处理位置）', 'fa-solid fa-thumbtack', buildInjectionBody),
        section('Preset JSON 整理器', 'fa-solid fa-list-ordered', buildPresetBody),
        section('图片格式转换', 'fa-solid fa-file-image', buildConvertBody),
    ]);
    container.append(panel);
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

let inited = false;

async function init() {
    if (inited) return;
    inited = true;
    try { S(); } catch { /* ignore */ }

    // 1) 图片库载入内存（宏 / 注入的数据源）
    try {
        for (const meta of S().imageMeta.slice()) {
            const dataUrl = await idbGet(meta.id);
            if (dataUrl) indexImage(meta, dataUrl);
        }
    } catch (e) {
        console.warn(`${EXT_NAME}: 图片库载入失败`, e);
    }

    // 2) 宏引擎（新版优先，旧版兜底）
    try {
        const mod = await import('../../../macros/macro-system.js');
        macrosApi = mod.macros || null;
    } catch { /* 旧版 ST 没有新宏引擎 */ }
    try {
        const mod = await import('../../../macros.js');
        legacyMacros = mod.MacrosParser || mod.macros || null;
    } catch { /* ignore */ }
    registerMacro();

    // 3) 请求拦截（把 <img data:> 变成真正的图片内容）
    patchFetch();

    // 4) 跟随 ST 的“媒体内联”设置（若能读到）
    try {
        openaiMod = await import('../../../openai.js');
    } catch { /* ignore */ }

    // 5) 注入 & UI
    applyInjections();
    buildUi();
    eventSource.on(event_types.APP_READY, () => buildUi());

    eventSource.on(event_types.SETTINGS_LOADED, () => { S(); });
    console.log(`${EXT_NAME}: 初始化完成`);
}

// 新版 ST：manifest hooks.activate 调用 init
export { init };

// 兜底：无 hooks 支持的旧版 ST / 手动启用
jQuery(() => setTimeout(() => init().catch(e => console.error(EXT_NAME, e)), 0));
