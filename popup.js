// content.js — robust snapshotting + smart filling across frames
(() => {
  "use strict";

  // ---------- Utilities ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

  const normalize = (s) => (s ?? "")
    .toString()
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    // hidden via dimensions or off-screen containers are still interactable sometimes; prefer offsetParent check
    if (el.offsetParent === null && cs.position !== "fixed") return false;
    return !el.disabled && !el.readOnly;
  };

  const getRole = (el) => (el.getAttribute && el.getAttribute("role")) || "";

  const getAttr = (el, k) => (el.getAttribute && el.getAttribute(k)) || "";

  const hash32 = (str) => {
    // djb2-ish
    let h = 5381, i = str.length;
    while (i) h = (h * 33) ^ str.charCodeAt(--i);
    return (h >>> 0).toString(36);
  };

  const shortPath = (el) => {
    // build a short CSS-ish path from nearest stable container
    const parts = [];
    let n = el;
    let steps = 0;
    while (n && n.nodeType === 1 && steps < 6) {
      let seg = n.nodeName.toLowerCase();
      if (n.id) { seg += `#${n.id}`; parts.unshift(seg); break; }
      let cls = (n.className && typeof n.className === "string") ? n.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
      if (cls) seg += `.${cls}`;
      parts.unshift(seg);
      n = n.parentElement;
      steps++;
    }
    return parts.join(">");
  };

  const nearestSectionText = (el) => {
    // Look up-heading or section titles near this control
    let n = el;
    while (n && n.nodeType === 1) {
      // Check previous siblings for headings
      let p = n.previousElementSibling;
      while (p) {
        if (/^H[1-6]$/i.test(p.tagName) || getRole(p) === "heading" || p.classList.contains("section-title")) {
          const t = normalize(p.innerText || p.textContent || "");
          if (t) return t.slice(0, 100);
        }
        p = p.previousElementSibling;
      }
      n = n.parentElement;
    }
    return "";
  };

  // popup.js — status wiring
(function () {
  const statusText = document.getElementById('statusText');
  const statusBadge = document.getElementById('statusBadge');

  function setStatus(ok) {
    if (ok) {
      statusText.textContent = 'זוהה טופס PDF';
      statusBadge.textContent = '✅';
    } else {
      statusText.textContent = 'לא זוהה PDF בדף';
      statusBadge.textContent = '❌';
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender) => {
    if (msg?.type === 'PDF_DETECTED') setStatus(!!msg.present);
  });

  // also query the active tab in case the message arrived before popup opened
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'PING_PDF_STATUS' }, resp => {
      // if content.js replies, great; if not, keep default text
      if (resp && 'present' in resp) setStatus(!!resp.present);
    });
  });
})();


  const labelFor = (el) => {
    try {
      if (!el) return "";
      // explicit label
      const id = el.id && CSS.escape ? CSS.escape(el.id) : el.id;
      if (id) {
        const lab = el.ownerDocument.querySelector(`label[for="${id}"]`);
        if (lab && lab.innerText) return normalize(lab.innerText);
      }
      // aria-label / title / placeholder
      const aria = el.getAttribute("aria-label");
      if (aria) return normalize(aria);
      const title = el.getAttribute("title");
      if (title) return normalize(title);
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return normalize(placeholder);
      // label by proximity (preceding text cell)
      let n = el;
      for (let i = 0; i < 3 && n; i++) {
        const prev = n.previousElementSibling;
        if (prev) {
          const t = normalize(prev.innerText || prev.textContent || "");
          if (t) return t.slice(0, 120);
        }
        n = n.parentElement;
      }
      return "";
    } catch { return ""; }
  };

  const valueOf = (el) => {
    if (!el) return "";
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = getRole(el);
    if (tag === "input") {
      if (type === "checkbox") return el.checked ? "true" : "false";
      if (type === "radio") return el.checked ? "true" : "false";
      return el.value ?? "";
    }
    if (tag === "textarea") return el.value ?? "";
    if (tag === "select") return el.value ?? "";
    if (role === "textbox" || el.isContentEditable) {
      return (el.value != null) ? el.value : (el.innerText ?? el.textContent ?? "");
    }
    // generic fallback
    return (el.value != null) ? el.value : (el.innerText ?? el.textContent ?? "");
  };

  const useNativeSetter = (el, prop, value) => {
    // Use element class prototype descriptor to set values so frameworks (React/Vue) detect it.
    const proto = el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el[prop] = value;
    }
  };

  const fire = (el, type, opts={}) => {
    const e = new Event(type, { bubbles: true, cancelable: true, composed: true, ...opts });
    el.dispatchEvent(e);
  };

  // ---------- Discovery (incl. Shadow DOM) ----------
  const CONTROL_SELECTOR =
    "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), " +
    "[contenteditable=true]:not([aria-disabled=true]), [role='textbox']:not([aria-disabled=true]), [role='combobox']:not([aria-disabled=true]), " +
    "[role='checkbox']:not([aria-disabled=true]), [role='radio']:not([aria-disabled=true])";

  const walkNodeTree = (root, out) => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!(n instanceof Element)) continue;
      // collect candidates
      if (n.matches && n.matches(CONTROL_SELECTOR) && isVisible(n)) {
        out.push(n);
      }
      // Shadow DOM
      const sr = n.shadowRoot;
      if (sr) stack.push(sr);
      // children
      for (let i = n.children.length - 1; i >= 0; i--) {
        stack.push(n.children[i]);
      }
    }
  };

  const collectFieldNodes = () => {
    const out = [];
    // include document + any shadow roots within
    walkNodeTree(document.documentElement, out);
    return out;
  };

  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = getRole(el);
    if (tag === "select") return "select";
    if (tag === "textarea") return "text";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["date","time","number","email","tel","url","text","search","password"].includes(type)) return "text";
      return "text";
    }
    if (role === "combobox") return "combobox";
    if (role === "checkbox") return "checkbox";
    if (role === "radio") return "radio";
    if (role === "textbox" || el.isContentEditable) return "text";
    return "text";
  };

  const fieldMeta = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = getRole(el);
    const name = el.getAttribute("name") || "";
    const id = el.getAttribute("id") || "";
    const dataName = el.getAttribute("data-name") || el.getAttribute("data-field") || el.getAttribute("data-id") || "";
    const ph = el.getAttribute("placeholder") || "";
    const ariaLabel = el.getAttribute("aria-label") || "";
    const lbl = labelFor(el) || "";
    const sec = nearestSectionText(el);
    const path = shortPath(el);

    return {
      tag, type, role, name, id, dataName, ph, ariaLabel, label: lbl, section: sec, path
    };
  };

  const makeKey = (m) => {
    // Stable-ish per-field fingerprint
    const src = [
      m.tag, m.type, m.role,
      `n=${m.name}`, `i=${m.id}`,
      `d=${m.dataName}`, `pl=${normalize(m.ph)}`,
      `al=${normalize(m.ariaLabel)}`,
      `l=${normalize(m.label)}`
    ].join("|");
    return hash32(src);
  };

  const makeSchema = (m) => {
    const parts = [
      m.tag, m.type ? `#${m.type}` : "",
      m.name ? `#n=${m.name}` : "",
      m.id ? `#i=${m.id}` : "",
      m.dataName ? `#d=${m.dataName}` : "",
      m.label ? `#l=${normalize(m.label)}` : "",
      m.path ? `#p=${normalize(m.path)}` : "",
      m.section ? `#sec=${normalize(m.section)}` : ""
    ];
    return parts.join("");
  };

  const snapshot = () => {
    const nodes = collectFieldNodes();
    const fields = nodes.map((el, idx) => {
      const m = fieldMeta(el);
      const k = makeKey(m);
      const s = makeSchema(m);
      const v = valueOf(el);
      return { idx, k, s, v, meta: m };
    });
    return { count: fields.length, fields };
  };

  // Form family signature = layout hash based on ordered schema (without values)
  const computeFamilyId = (snap) => {
    const sig = snap.fields.map(f => `${f.meta.tag}:${f.meta.type}:${normalize(f.meta.label)}:${normalize(f.meta.section)}:${normalize(f.meta.path)}`).join(";");
    return "fam_" + hash32(sig);
  };

  // TemplateId attempt: URL + highest-level frame path + form title if any
  const computeTemplateId = () => {
    const u = new URL(location.href);
    const parts = [u.pathname, u.searchParams.get("DocId") || "", document.title || "", window.name || ""]
      .filter(Boolean).join("|");
    return "tpl_" + hash32(parts);
  };

  // Wait for hydration: field count + first 5 fingerprints stable for X ms
  const waitForStableFields = async (minStableMs = 500, maxWaitMs = 6000) => {
    const start = now();
    let last = null;
    let stableSince = 0;
    while (now() - start < maxWaitMs) {
      const snap = snapshot();
      const head = snap.fields.slice(0, 5).map(f => f.k).join(",");
      const sig = `${snap.count}|${head}`;
      if (sig === last) {
        if (!stableSince) stableSince = now();
        if (now() - stableSince >= minStableMs) return true;
      } else {
        last = sig;
        stableSince = 0;
      }
      await sleep(150);
    }
    return true; // best effort
  };

  // ---------- Writers ----------
  const clickWithBubbling = (el) => {
    el.focus({ preventScroll: true });
    el.click();
    fire(el, "input");
    fire(el, "change");
    el.blur();
  };

  const setTextValue = async (el, text) => {
    el.focus({ preventScroll: true });
    // Native setter path (React/Vue)
    useNativeSetter(el, "value", text);
    fire(el, "input");
    fire(el, "change");
    el.blur();
    // If it's a combobox with popup, try to pick an option
    const role = getRole(el);
    if (role === "combobox" || el.getAttribute("aria-autocomplete")) {
      // open list
      el.focus({ preventScroll: true });
      fire(el, "keydown", { key: "ArrowDown" });
      await sleep(100);
      const listId = el.getAttribute("aria-controls");
      const list = listId ? document.getElementById(listId) : null;
      if (list) {
        // find option by exact text
        const items = Array.from(list.querySelectorAll('[role="option"], li, div')).filter(n => isVisible(n));
        const target = items.find(n => normalize(n.innerText || n.textContent || "") === normalize(text))
          || items.find(n => normalize(n.innerText || n.textContent || "").includes(normalize(text)));
        if (target) {
          target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          target.click();
          fire(el, "change");
          el.blur();
        }
      }
    }
  };

  const setSelectValue = (el, desired) => {
    // Try by value, then by text
    const opts = Array.from(el.options || []);
    let opt = opts.find(o => normalize(o.value) === normalize(desired));
    if (!opt) opt = opts.find(o => normalize(o.text) === normalize(desired));
    if (opt) {
      useNativeSetter(el, "value", opt.value);
      fire(el, "input");
      fire(el, "change");
      return true;
    }
    return false;
  };

  const setMaskedValue = async (el, text) => {
    // Slow path: clear then type char-by-char
    el.focus({ preventScroll: true });
    // select all
    el.setSelectionRange?.(0, (el.value || "").length);
    fire(el, "keydown", { key: "Backspace" });
    useNativeSetter(el, "value", "");
    fire(el, "input");
    for (const ch of text.split("")) {
      fire(el, "keydown", { key: ch });
      useNativeSetter(el, "value", (el.value || "") + ch);
      fire(el, "input");
      fire(el, "keyup", { key: ch });
      await sleep(10);
    }
    fire(el, "change");
    el.blur();
  };

  const setCheckboxValue = (el, desired) => {
    const want = (typeof desired === "string") ? ["true","yes","on","1","כן"].includes(normalize(desired)) : !!desired;
    if (el.checked !== want) clickWithBubbling(el);
  };

  const setRadioValue = (el, desired) => {
    const group = el.name ? document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`) : [el];
    const pickByLabel = (val) => {
      for (const r of group) {
        const lbl = labelFor(r);
        if (normalize(lbl) === normalize(val)) { clickWithBubbling(r); return true; }
      }
      return false;
    };
    if (!desired) { clickWithBubbling(el); return; }
    if (!pickByLabel(desired)) {
      // fallback: first in group
      const r = Array.from(group)[0];
      if (r) clickWithBubbling(r);
    }
  };

  // ---------- Matching ----------
  const buildIndex = () => {
    const snap = snapshot();
    const byKey = new Map();
    const all = [];
    for (const f of snap.fields) {
      byKey.set(f.k, f);
      all.push(f);
    }
    return { byKey, all };
  };

  const scoreCandidate = (entry, cand) => {
    // Higher is better
    let score = 0;
    if (entry.k && cand.k === entry.k) score += 1000;
    const parts = (t) => {
      const o = { tag:"", type:"", name:"", id:"", data:"", label:"", path:"", sec:"" };
      const m = t.match(/^([a-z]+)(?:#([a-z0-9_-]+))?(.*)$/i);
      if (m) { o.tag = m[1]; o.type = m[2] || ""; }
      const kv = t.split("#").slice(1);
      for (const p of kv) {
        const mm = p.split("=");
        const k = mm[0], v = mm.slice(1).join("=") || "";
        if (k === "n") o.name = v;
        if (k === "i") o.id = v;
        if (k === "d") o.data = v;
        if (k === "l") o.label = v;
        if (k === "p") o.path = v;
        if (k === "sec") o.sec = v;
      }
      return o;
    };
    const a = parts(entry.s);
    const b = parts(cand.s);
    if (a.tag && a.tag === b.tag) score += 50;
    if (a.type && a.type === b.type) score += 50;
    if (a.name && a.name === b.name) score += 80;
    if (a.id && a.id === b.id) score += 100;
    if (a.data && a.data === b.data) score += 80;
    if (a.label && a.label === b.label) score += 60;
    // fuzzy label/section/path
    if (a.sec && b.sec && normalize(a.sec) === normalize(b.sec)) score += 30;
    if (a.path && b.path && normalize(a.path) === normalize(b.path)) score += 25;
    return score;
  };

  // ---------- Global Frame State ----------
  const STATE = {
    initialBaseline: null,
    familyId: null,
    templateId: null,
    lastLog: [],
  };

  // Capture baseline ASAP on content script load
  (async () => {
    await waitForStableFields(600, 8000);
    const base = snapshot();
    STATE.initialBaseline = base;
    STATE.familyId = computeFamilyId(base);
    STATE.templateId = computeTemplateId();
  })();

  // ---------- Public API via messaging ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg && msg.cmd === "PING_STATUS") {
          const snap = snapshot();
          sendResponse({
            ok: true,
            href: location.href,
            frameName: window.name || "",
            count: snap.count,
            familyId: STATE.familyId || computeFamilyId(snap),
            templateId: STATE.templateId || computeTemplateId(),
            title: document.title || ""
          });
          return;
        }

        if (msg && msg.cmd === "COLLECT_INITIAL_BASELINE") {
          await waitForStableFields(600, 8000);
          const base = STATE.initialBaseline || snapshot();
          sendResponse({ ok: true, baseline: base, familyId: STATE.familyId, templateId: STATE.templateId });
          return;
        }

        if (msg && msg.cmd === "COLLECT_SNAPSHOT") {
          await waitForStableFields(400, 6000);
          const snap = snapshot();
          sendResponse({ ok: true, snapshot: snap });
          return;
        }

        if (msg && msg.cmd === "APPLY_PRESET" && Array.isArray(msg.entries)) {
          await waitForStableFields(400, 6000);
          const results = [];
          for (const entry of msg.entries) {
            // Rebuild index fresh each time to survive re-renders
            const idx = buildIndex();
            let matched = null;
            let matchedBy = "none";
            if (entry.k && idx.byKey.has(entry.k)) { matched = idx.byKey.get(entry.k); matchedBy = "key"; }
            if (!matched) {
              // score all
              let best = null, bestScore = 0;
              for (const c of idx.all) {
                const s = scoreCandidate(entry, c);
                if (s > bestScore) { bestScore = s; best = c; }
              }
              if (best && bestScore >= 120) { matched = best; matchedBy = "schema"; }
            }

            if (!matched) {
              results.push({ entry, matchedBy, wrote: false, reason: "no_match" });
              continue;
            }

            // Write according to kind
            const el = collectFieldNodes().find(n => {
              const m = fieldMeta(n);
              return makeKey(m) === matched.k;
            });
            if (!el || !isVisible(el)) {
              results.push({ entry, matchedBy, wrote: false, reason: "not_visible" });
              continue;
            }

            const before = valueOf(el);
            let wrote = false, reason = "ok";
            try {
              const kind = kindOf(el);
              if (kind === "text") {
                // Try masked/format detection (simple heuristic)
                if (el.getAttribute("data-mask") || /[_-]/.test(el.value || "")) {
                  await setMaskedValue(el, entry.v);
                } else {
                  await setTextValue(el, entry.v);
                }
                wrote = true;
              } else if (kind === "select") {
                wrote = setSelectValue(el, entry.v);
                if (!wrote) { reason = "option_not_found"; }
              } else if (kind === "checkbox") {
                setCheckboxValue(el, entry.v);
                wrote = true;
              } else if (kind === "radio") {
                setRadioValue(el, entry.v);
                wrote = true;
              } else if (kind === "combobox") {
                await setTextValue(el, entry.v);
                wrote = true;
              } else {
                await setTextValue(el, entry.v);
                wrote = true;
              }
            } catch (e) {
              wrote = false; reason = "error:" + (e && e.message || "unknown");
            }

            // Re-resolve and verify
            await sleep(50);
            const afterIdx = buildIndex();
            const after = (afterIdx.byKey.get(matched.k) || matched).v;
            const ok = wrote && (normalize(after) === normalize(entry.v) || kindOf(el) === "checkbox" || kindOf(el) === "radio");
            results.push({
              entry, matchedBy,
              wrote: ok, reason: ok ? "ok" : reason,
              fieldInfo: { key: matched.k, schema: matched.s, before, after }
            });
          }

          STATE.lastLog = results;
          sendResponse({ ok: true, results });
          return;
        }

        if (msg && msg.cmd === "GET_LAST_LOG") {
          sendResponse({ ok: true, log: STATE.lastLog || [] });
          return;
        }

        // Unknown
        sendResponse({ ok: false, error: "unknown_cmd" });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    // indicate async response
    return true;
  });
})();
