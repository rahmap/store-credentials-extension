// Content script: deteksi field login dinamis, badge, picker terisolasi, autofill, capture.
// Mendukung form login dengan format apa pun: hanya Password, Username+Password,
// NIP+User+Password, PIN saja, atau form multi-field kustom.

(() => {
  if (window.__vaultLocalLoaded) {
    return;
  }
  window.__vaultLocalLoaded = true;

  const MSG = "vault-local";
  const FRAME_MSG = "vault-local-frame";
  const Z = 2147483647;
  const SCAN_DEBOUNCE = 300;

  let settings = null;
  let targets = [];
  let host = null;
  let shadow = null;
  let frame = null;
  let badge = null;
  let activeTarget = null;
  let lastOpenAt = 0;
  let pendingAutoFill = false;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ source: MSG }, msg),
          (res) => {
            void chrome.runtime.lastError;
            resolve(res || null);
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  function isVisible(el) {
    if (!el || !el.isConnected) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) > 0.05
    );
  }

  function isFillableInput(el) {
    if (!el || el.tagName !== "INPUT") {
      return false;
    }
    if (!isVisible(el) || el.readOnly || el.disabled) {
      return false;
    }
    const type = String(el.type || "text").toLowerCase();
    return ["text", "password", "email", "tel", "number", "url", ""].includes(
      type,
    );
  }

  function cleanLabel(s) {
    return String(s || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function getLabel(el) {
    if (!el) {
      return "";
    }
    if (el.labels && el.labels.length > 0) {
      const text = cleanLabel(
        Array.from(el.labels)
          .map((l) => l.textContent)
          .join(" "),
      );
      if (text && text.length <= 50) {
        return text;
      }
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) {
      return cleanLabel(ariaLabel);
    }
    const ariaId = el.getAttribute("aria-labelledby");
    if (ariaId) {
      const labelEl = document.getElementById(ariaId);
      if (labelEl && labelEl.textContent.trim()) {
        return cleanLabel(labelEl.textContent);
      }
    }
    if (el.placeholder && el.placeholder.trim()) {
      return cleanLabel(el.placeholder);
    }
    const parent = el.closest(
      "label, .form-group, .field, .input-group, .form-row, td, tr, div",
    );
    if (parent) {
      const lbl = parent.querySelector("label, .label, dt, th, span");
      if (lbl && lbl !== el && lbl.textContent.trim()) {
        const txt = cleanLabel(lbl.textContent);
        if (txt.length > 0 && txt.length <= 40) {
          return txt;
        }
      }
    }
    return el.name || el.id || "";
  }

  function describeInput(el) {
    return {
      el,
      name: el.name || el.id || "",
      id: el.id || "",
      autocomplete: String(el.getAttribute("autocomplete") || "").toLowerCase(),
      type: String(el.type || "text").toLowerCase(),
      label: getLabel(el),
    };
  }

  function collectLoginTargets() {
    const list = [];
    const processed = new Set();
    const passwords = Array.from(
      document.querySelectorAll("input[type='password']"),
    ).filter(isVisible);

    for (const pwd of passwords) {
      const form =
        pwd.form ||
        pwd.closest("form") ||
        pwd.closest(".login-box, .auth-box, .signin, main, body");
      const scope = form || document;
      const inputs = Array.from(scope.querySelectorAll("input")).filter(
        isFillableInput,
      );
      const descriptors = inputs.map(describeInput);
      const userDesc = descriptors.find((d) => {
        if (d.el === pwd || d.type === "password") return false;
        const n = (d.name + " " + d.id + " " + d.label).toLowerCase();
        return (
          d.autocomplete.includes("username") ||
          /(user|email|login|nip|nik|acct|account)/.test(n)
        );
      });
      const anchor = (userDesc && userDesc.el) || pwd;
      list.push({
        form,
        anchor,
        password: pwd,
        username: userDesc ? userDesc.el : null,
        descriptors,
      });
      inputs.forEach((i) => processed.add(i));
    }

    if (list.length === 0) {
      const standaloneLogins = Array.from(
        document.querySelectorAll("input"),
      ).filter((inp) => {
        if (processed.has(inp) || !isFillableInput(inp)) return false;
        const ac = String(inp.getAttribute("autocomplete") || "").toLowerCase();
        const n = (
          String(inp.name || "") +
          " " +
          String(inp.id || "") +
          " " +
          getLabel(inp)
        ).toLowerCase();
        return (
          ac.includes("username") ||
          ac.includes("email") ||
          /(user|email|login|nip|nik|acct|account)/.test(n)
        );
      });
      if (standaloneLogins.length > 0) {
        const first = standaloneLogins[0];
        const form = first.form || first.closest("form") || null;
        const scope = form || document;
        const inputs = Array.from(scope.querySelectorAll("input")).filter(
          isFillableInput,
        );
        list.push({
          form,
          anchor: first,
          password: null,
          username: first,
          descriptors: inputs.map(describeInput),
        });
      }
    }

    targets = list;
    return list;
  }

  function ensureShell() {
    if (host && host.isConnected) {
      return shadow;
    }
    host = document.createElement("div");
    host.id = "vault-local-host";
    host.style.cssText = `all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:${Z};pointer-events:none;`;
    shadow = host.attachShadow({ mode: "closed" });
    (document.documentElement || document.body).appendChild(host);
    return shadow;
  }

  let currentAnchorInput = null;

  function badgeStyle() {
    return `
      .vl-badge{
        position:fixed;width:18px;height:18px;border-radius:4px;border:0;padding:0;cursor:pointer;
        background:#1f6feb;color:#fff;display:inline-flex;align-items:center;justify-content:center;
        box-shadow:0 1px 3px rgba(0,0,0,.35);pointer-events:auto;z-index:${Z};
        opacity:0.85;transition:opacity .15s ease, transform .15s ease, background .15s ease;
      }
      .vl-badge:hover{opacity:1;transform:scale(1.08);background:#388bfd}
      .vl-frame{
        position:fixed;border:0;background:transparent;pointer-events:auto;z-index:${Z};
        color-scheme:light dark;
      }
      .vl-frame--center{width:380px;height:520px;top:50%;left:50%;transform:translate(-50%,-50%)}
      .vl-frame--field{width:340px;height:420px}
      .vl-backdrop{position:fixed;inset:0;background:rgba(8,10,14,.42);pointer-events:auto;z-index:${Z - 1}}
    `;
  }

  function renderBadge(specificAnchor) {
    const root = ensureShell();
    if (badge) {
      badge.remove();
      badge = null;
    }
    if (!settings || settings.showBadge === false || targets.length === 0) {
      return;
    }
    const target = targets[0];
    const anchor = specificAnchor || currentAnchorInput || target.anchor;
    if (!isVisible(anchor)) {
      return;
    }
    currentAnchorInput = anchor;

    const rect = anchor.getBoundingClientRect();
    if (
      rect.width < 45 ||
      rect.height < 18 ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight
    ) {
      return;
    }

    const style = document.createElement("style");
    style.textContent = badgeStyle();
    if (!root.querySelector("style[data-vl-style]")) {
      style.setAttribute("data-vl-style", "1");
      root.appendChild(style);
    }

    const iconSize = 18;
    const top = rect.top + (rect.height - iconSize) / 2;
    const left = rect.right - iconSize - 4;

    badge = document.createElement("button");
    badge.className = "vl-badge";
    badge.type = "button";
    badge.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
    badge.title = "Vault Local: klik untuk pilih kredensial";
    badge.style.top = String(Math.round(top)) + "px";
    badge.style.left = String(Math.round(left)) + "px";
    badge.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (accountMenu) {
        closeAccountMenu();
        return;
      }
      await showAccountMenuOrPicker(anchor, target);
    });
    root.appendChild(badge);
  }

  function openPicker(target, placement) {
    const throttle = Date.now() - lastOpenAt;
    if (frame && throttle < 250) {
      return;
    }
    lastOpenAt = Date.now();
    const root = ensureShell();
    closePicker(false);
    activeTarget = target || targets[0] || null;

    const style = document.createElement("style");
    style.setAttribute("data-vl-style", "1");
    style.textContent = badgeStyle();
    if (!root.querySelector("style[data-vl-style]")) {
      root.appendChild(style);
    }

    const backdrop = document.createElement("div");
    backdrop.className = "vl-backdrop";
    backdrop.addEventListener("click", () => closePicker(true));
    root.appendChild(backdrop);

    frame = document.createElement("iframe");
    frame.className =
      "vl-frame " +
      (placement === "field" ? "vl-frame--field" : "vl-frame--center");
    frame.setAttribute("allow", "clipboard-write");
    frame.src = chrome.runtime.getURL("src/overlay.html");
    if (placement === "field") {
      const anchor = activeTarget ? activeTarget.anchor : null;
      const rect = anchor
        ? anchor.getBoundingClientRect()
        : { top: 120, left: 120, bottom: 160, right: 300 };
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - 348);
      const top = Math.min(
        Math.max(8, rect.bottom + 8),
        window.innerHeight - 428,
      );
      frame.style.top = String(top) + "px";
      frame.style.left = String(left) + "px";
      frame.style.transform = "none";
    }
    root.appendChild(frame);
  }

  function closePicker(notifyFrame) {
    if (frame) {
      if (notifyFrame) {
        try {
          frame.contentWindow.postMessage(
            { source: MSG, type: "CLOSE" },
            chrome.runtime.getURL(""),
          );
        } catch {
          /* abaikan */
        }
      }
      frame.remove();
      frame = null;
    }
    if (shadow) {
      const backdrop = shadow.querySelector(".vl-backdrop");
      if (backdrop) {
        backdrop.remove();
      }
    }
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  function fillField(el, value) {
    if (!el) {
      return false;
    }
    el.focus();
    setNativeValue(el, String(value == null ? "" : value));
    fire(el, "input");
    fire(el, "change");
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.style.transition = "outline-color .2s";
    el.style.outline = "2px solid #1f6feb";
    window.setTimeout(() => {
      el.style.outline = "";
    }, 900);
    return true;
  }

  function fillItem(item) {
    if (!item) {
      return false;
    }
    collectLoginTargets();
    let target = activeTarget;
    if (!target || !target.anchor || !target.anchor.isConnected) {
      target = targets[0] || null;
    }
    if (!target || !target.descriptors) {
      return false;
    }

    let filledAny = false;
    const dom = target.descriptors;
    const used = new Set();

    if (Array.isArray(item.fields) && item.fields.length > 0) {
      for (const f of item.fields) {
        if (f.value == null || f.value === "") {
          continue;
        }
        const fn = String(f.name || "").toLowerCase();
        const fl = String(f.label || "").toLowerCase();
        let m = dom.find(
          (d) =>
            !used.has(d.el) &&
            ((fn &&
              (d.name.toLowerCase() === fn || d.id.toLowerCase() === fn)) ||
              (d.id &&
                f.id &&
                d.id.toLowerCase() === String(f.id).toLowerCase())),
        );
        if (!m && fl) {
          m = dom.find(
            (d) =>
              !used.has(d.el) &&
              (d.label.toLowerCase() === fl ||
                (fl.length > 2 && d.label.toLowerCase().includes(fl)) ||
                (d.label.length > 2 && fl.includes(d.label.toLowerCase()))),
          );
        }
        if (!m && (f.type === "password" || /pass|pin/i.test(fn))) {
          m = dom.find((d) => !used.has(d.el) && d.type === "password");
        }
        if (!m && /user|email|login|nip/i.test(fn)) {
          m = dom.find(
            (d) =>
              !used.has(d.el) &&
              d.type !== "password" &&
              (d.autocomplete.includes("username") ||
                /(user|login|email|nip|nik)/i.test(d.name + " " + d.label)),
          );
        }
        if (m) {
          used.add(m.el);
          if (fillField(m.el, f.value)) {
            filledAny = true;
          }
        }
      }
    }

    if (item.password) {
      const pwdDesc = dom.find((d) => !used.has(d.el) && d.type === "password");
      if (pwdDesc) {
        used.add(pwdDesc.el);
        if (fillField(pwdDesc.el, item.password)) {
          filledAny = true;
        }
      }
    }

    if (item.username) {
      let userDesc = dom.find(
        (d) =>
          !used.has(d.el) &&
          (d.autocomplete.includes("username") ||
            /(user|login|email|nip|nik|acct)/i.test(d.name + " " + d.label)),
      );
      if (!userDesc) {
        userDesc = dom.find((d) => !used.has(d.el) && d.type !== "password");
      }
      if (userDesc) {
        used.add(userDesc.el);
        if (fillField(userDesc.el, item.username)) {
          filledAny = true;
        }
      }
    }

    if (item.totpCode) {
      const otpDesc = dom.find(
        (d) =>
          !used.has(d.el) &&
          (d.autocomplete === "one-time-code" ||
            /(otp|2fa|code|token|mfa)/i.test(d.name + " " + d.label)),
      );
      if (otpDesc) {
        used.add(otpDesc.el);
        if (fillField(otpDesc.el, item.totpCode)) {
          filledAny = true;
        }
      }
    }

    activeTarget = target;
    return filledAny;
  }

  function isSearchOrFilterForm(form, descriptors) {
    if (!form) return false;
    const formRole = String(form.getAttribute("role") || "").toLowerCase();
    const formAction = String(form.getAttribute("action") || "").toLowerCase();
    if (formRole === "search" || /(search|find|filter)/.test(formAction)) {
      return true;
    }
    const hasPassword = descriptors.some((d) => d.type === "password");
    if (!hasPassword) {
      const onlySearch = descriptors.every((d) =>
        /(search|query|keyword|q|find)/i.test(d.name + " " + d.label),
      );
      if (onlySearch) return true;
    }
    return false;
  }

  function captureFromForm(target) {
    if (!target || !target.descriptors || target.descriptors.length === 0) {
      return null;
    }
    if (isSearchOrFilterForm(target.form, target.descriptors)) {
      return null;
    }
    const filled = target.descriptors.filter(
      (d) => d.el.value && d.el.value.length > 0,
    );
    if (filled.length === 0) {
      return null;
    }

    const pwds = filled.filter((d) => d.type === "password");
    let username = "";
    let password = "";
    const dynamicFields = [];

    if (pwds.length >= 2) {
      const newPwd = pwds.find((d) =>
        /(new|baru)/i.test(d.name + " " + d.label + " " + d.autocomplete),
      );
      if (newPwd) {
        password = newPwd.el.value;
      } else {
        password = pwds[pwds.length - 1].el.value;
      }
    } else if (pwds.length === 1) {
      password = pwds[0].el.value;
    }

    for (const d of filled) {
      const val = d.el.value;
      const label = d.label || d.name || "Field";
      const name = d.name || d.id || label.toLowerCase().replace(/\s+/g, "_");
      if (d.type !== "password") {
        const isUser =
          d.autocomplete.includes("username") ||
          d.autocomplete.includes("email") ||
          /(user|email|login|nip|nik|account|acct)/i.test(name) ||
          /(user|email|login|nip|nik|pengguna)/i.test(label);
        if (isUser && !username) {
          username = val;
        }
        dynamicFields.push({
          name,
          label,
          type: "text",
          value: val,
        });
      }
    }

    if (password) {
      dynamicFields.push({
        name: "password",
        label: "Password",
        type: "password",
        value: password,
      });
    }

    if (!username) {
      const firstNonPass = filled.find((d) => d.type !== "password");
      if (firstNonPass) {
        username = firstNonPass.el.value;
      }
    }

    if (!password && (!username || username.length < 2)) {
      return null;
    }

    return {
      url: location.href,
      username,
      password,
      fields: dynamicFields,
    };
  }

  let accountMenu = null;

  function closeAccountMenu() {
    if (accountMenu) {
      accountMenu.remove();
      accountMenu = null;
    }
  }

  async function showAccountMenuOrPicker(anchorInput, target) {
    const res = await send({ type: "CANDIDATES", url: location.href });
    if (!res || !res.ok || !res.result || res.result.locked) {
      openPicker(target, "field");
      return;
    }
    const items = res.result.items || [];
    if (items.length === 0) {
      openPicker(target, "field");
      return;
    }

    closeAccountMenu();
    const root = ensureShell();
    if (!root.querySelector("style[data-vl-menu-style]")) {
      const st = document.createElement("style");
      st.setAttribute("data-vl-menu-style", "1");
      st.textContent = `
        .vl-menu {
          position: fixed;
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
          z-index: ${Z};
          min-width: 220px;
          max-width: 320px;
          padding: 4px;
          font: 12px/1.4 system-ui, -apple-system, sans-serif;
          color: #e6edf3;
          pointer-events: auto;
          animation: vlFadeIn 0.15s ease-out;
          box-sizing: border-box;
        }
        .vl-menu-title {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #8b949e;
          padding: 4px 8px 2px;
          font-weight: 600;
        }
        .vl-menu-item {
          padding: 6px 8px;
          border-radius: 6px;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .vl-menu-item:hover {
          background: #1f6feb;
          color: #ffffff;
        }
        .vl-menu-user {
          font-weight: 600;
          font-size: 12.5px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .vl-menu-sub {
          font-size: 11px;
          opacity: 0.78;
          font-family: ui-monospace, Consolas, monospace;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .vl-menu-footer {
          border-top: 1px solid #30363d;
          margin-top: 4px;
          padding-top: 4px;
        }
        .vl-menu-footer-btn {
          width: 100%;
          text-align: left;
          background: transparent;
          border: 0;
          color: #58a6ff;
          cursor: pointer;
          font-size: 11px;
          padding: 4px 8px;
          border-radius: 4px;
        }
        .vl-menu-footer-btn:hover {
          background: rgba(88, 166, 255, 0.12);
        }
      `;
      root.appendChild(st);
    }

    const rect = anchorInput.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "vl-menu";
    const top = Math.min(window.innerHeight - 200, rect.bottom + 4);
    const left = Math.min(
      Math.max(8, rect.right - 220),
      window.innerWidth - 230,
    );
    menu.style.top = String(Math.round(top)) + "px";
    menu.style.left = String(Math.round(left)) + "px";

    const title = document.createElement("div");
    title.className = "vl-menu-title";
    title.textContent = "Pilih Kredensial (" + items.length + ")";
    menu.appendChild(title);

    for (const it of items) {
      const opt = document.createElement("div");
      opt.className = "vl-menu-item";

      const display = it.label || it.username || it.title || "Akun";
      const u = document.createElement("div");
      u.className = "vl-menu-user";
      u.textContent = display;

      const sub = document.createElement("div");
      sub.className = "vl-menu-sub";
      sub.textContent =
        it.label && it.username && it.label !== it.username
          ? `${it.username} · ${it.title}`
          : it.title !== display
            ? it.title
            : it.url
              ? new URL(it.url).pathname
              : "";

      opt.append(u, sub);
      opt.addEventListener("mousedown", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeAccountMenu();
        const full = await send({ type: "FILL_ITEM", id: it.id });
        if (full && full.ok && full.result && full.result.item) {
          fillItem(full.result.item);
        }
      });
      menu.appendChild(opt);
    }

    const footer = document.createElement("div");
    footer.className = "vl-menu-footer";
    const moreBtn = document.createElement("button");
    moreBtn.className = "vl-menu-footer-btn";
    moreBtn.type = "button";
    moreBtn.textContent = "Cari semua entri / buka vault...";
    moreBtn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeAccountMenu();
      openPicker(target, "field");
    });
    footer.appendChild(moreBtn);
    menu.appendChild(footer);

    root.appendChild(menu);
    accountMenu = menu;
  }

  let saveBanner = null;
  let bannerTimer = null;

  function promptStyle() {
    return `
      .vl-prompt {
        position: fixed;
        top: 16px;
        left: 16px;
        width: 320px;
        max-width: calc(100vw - 32px);
        background: #161b22;
        color: #e6edf3;
        border: 1px solid #388bfd;
        border-radius: 10px;
        padding: 12px 14px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        z-index: ${Z};
        pointer-events: auto;
        box-sizing: border-box;
        animation: vlFadeIn 0.2s ease-out;
      }
      .vl-prompt * {
        box-sizing: border-box;
      }
      .vl-prompt-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .vl-prompt-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #388bfd;
        flex: none;
      }
      .vl-prompt-title {
        font-weight: 600;
        font-size: 13px;
        color: #e6edf3;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .vl-prompt-close {
        background: transparent;
        border: 0;
        color: #8b949e;
        cursor: pointer;
        padding: 0 4px;
        font-size: 15px;
        line-height: 1;
      }
      .vl-prompt-close:hover {
        color: #e6edf3;
      }
      .vl-prompt-body {
        margin-bottom: 10px;
        font-size: 12px;
        color: #8b949e;
      }
      .vl-prompt-user {
        color: #e6edf3;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .vl-prompt-url {
        font-family: ui-monospace, Consolas, monospace;
        color: #8b949e;
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .vl-prompt-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .vl-prompt-btn {
        appearance: none;
        border: 1px solid #30363d;
        background: #21262d;
        color: #c9d1d9;
        border-radius: 6px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }
      .vl-prompt-btn:hover {
        border-color: #8b949e;
      }
      .vl-prompt-btn-primary {
        background: #1f6feb;
        border-color: #1f6feb;
        color: #ffffff;
      }
      .vl-prompt-btn-primary:hover {
        background: #388bfd;
      }
      .vl-prompt-ok {
        color: #3fb950;
        font-weight: 600;
        font-size: 12px;
      }
      .vl-prompt-input {
        width: 100%;
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 6px;
        color: #e6edf3;
        padding: 5px 8px;
        font-size: 12px;
        margin-top: 6px;
        box-sizing: border-box;
      }
      .vl-prompt-input:focus {
        outline: none;
        border-color: #388bfd;
      }
      @keyframes vlFadeIn {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes vlFadeOut {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-8px); }
      }
    `;
  }

  function showSaveBanner(payload) {
    if (!payload || saveBanner) {
      return;
    }
    const root = ensureShell();
    if (!root.querySelector("style[data-vl-prompt-style]")) {
      const st = document.createElement("style");
      st.setAttribute("data-vl-prompt-style", "1");
      st.textContent = promptStyle();
      root.appendChild(st);
    }

    const banner = document.createElement("div");
    banner.className = "vl-prompt";

    const head = document.createElement("div");
    head.className = "vl-prompt-head";
    const dot = document.createElement("span");
    dot.className = "vl-prompt-dot";
    const isUpdate = payload.mode === "update";
    const title = document.createElement("span");
    title.className = "vl-prompt-title";
    title.textContent = isUpdate
      ? "Perbarui password di Vault?"
      : "Simpan ke Vault Local?";
    const close = document.createElement("button");
    close.className = "vl-prompt-close";
    close.type = "button";
    close.textContent = "\u2715";
    close.title = "Abaikan";
    close.addEventListener("click", () => dismissBanner());
    head.append(dot, title, close);

    const body = document.createElement("div");
    body.className = "vl-prompt-body";
    const userText = isUpdate
      ? (payload.username ? payload.username + " — " : "") +
        "Password baru terdeteksi"
      : payload.username ||
        (payload.fields && payload.fields[0]
          ? payload.fields[0].label + ": " + payload.fields[0].value
          : "Hanya Password");
    const userEl = document.createElement("div");
    userEl.className = "vl-prompt-user";
    userEl.textContent = userText;
    const urlEl = document.createElement("div");
    urlEl.className = "vl-prompt-url";
    urlEl.textContent = location.hostname || payload.url || "";
    const labelInp = document.createElement("input");
    labelInp.type = "text";
    labelInp.className = "vl-prompt-input";
    labelInp.placeholder = "Label akun (misal: Admin, Testing) [opsional]";
    labelInp.value = payload.label || "";
    body.append(userEl, urlEl, labelInp);

    const actions = document.createElement("div");
    actions.className = "vl-prompt-actions";
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "vl-prompt-btn";
    dismissBtn.type = "button";
    dismissBtn.textContent = "Jangan";
    dismissBtn.addEventListener("click", () => dismissBanner());

    const saveBtn = document.createElement("button");
    saveBtn.className = "vl-prompt-btn vl-prompt-btn-primary";
    saveBtn.type = "button";
    saveBtn.textContent = isUpdate ? "Perbarui" : "Simpan";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = isUpdate ? "Memperbarui\u2026" : "Menyimpan\u2026";
      const item = {
        id: payload.updateId || undefined,
        label: labelInp.value.trim() || undefined,
        title: payload.existingTitle || location.hostname || "entri baru",
        url: payload.url || location.href,
        username: payload.username || "",
        password: payload.password || "",
        fields: payload.fields || [],
      };
      const res = await send({ type: "SAVE", item, fromCapture: true });
      if (res && res.ok) {
        await send({ type: "DISMISS_CAPTURE" });
        body.replaceChildren();
        const ok = document.createElement("div");
        ok.className = "vl-prompt-ok";
        ok.textContent = isUpdate
          ? "\u2713 Password diperbarui di vault"
          : "\u2713 Kredensial tersimpan di vault";
        body.appendChild(ok);
        actions.remove();
        window.setTimeout(() => dismissBanner(), 1200);
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = "Simpan";
        const err = (res && res.error) || "gagal menyimpan";
        if (err.includes("terkunci")) {
          openPicker(null, "center");
          dismissBanner();
        } else {
          urlEl.textContent = err;
          urlEl.style.color = "#f85149";
        }
      }
    });

    actions.append(dismissBtn, saveBtn);
    banner.append(head, body, actions);
    root.appendChild(banner);
    saveBanner = banner;

    const startTimer = () => {
      if (bannerTimer) {
        window.clearTimeout(bannerTimer);
      }
      bannerTimer = window.setTimeout(() => {
        dismissBanner();
      }, 5000);
    };

    banner.addEventListener("mouseenter", () => {
      if (bannerTimer) {
        window.clearTimeout(bannerTimer);
        bannerTimer = null;
      }
    });

    banner.addEventListener("mouseleave", () => {
      startTimer();
    });

    startTimer();
  }

  function dismissBanner() {
    if (bannerTimer) {
      window.clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    if (saveBanner) {
      const b = saveBanner;
      saveBanner = null;
      b.style.animation = "vlFadeOut 0.2s ease-out forwards";
      window.setTimeout(() => b.remove(), 200);
    }
    send({ type: "DISMISS_CAPTURE" });
  }

  function onSubmit(ev) {
    if (!settings) {
      return;
    }
    const form = ev.target;
    collectLoginTargets();
    const target =
      targets.find(
        (t) => t.form === form || (form && form.contains(t.anchor)),
      ) || targets[0];
    const captured = captureFromForm(target);
    if (!captured) {
      return;
    }
    send({ type: "CAPTURE", payload: captured }).then((res) => {
      if (res && res.ok && res.result && res.result.captured) {
        window.setTimeout(() => {
          if (!saveBanner) {
            showSaveBanner(captured);
          }
        }, 1400);
      }
    });
  }

  function hookForms() {
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener(
      "click",
      (ev) => {
        const btn =
          ev.target && ev.target.closest
            ? ev.target.closest(
                "button,input[type='submit'],input[type='image']",
              )
            : null;
        if (!btn) {
          return;
        }
        const form = btn.form || (btn.closest && btn.closest("form"));
        if (form) {
          window.setTimeout(() => onSubmit({ target: form }), 0);
        }
      },
      true,
    );
  }

  function scan() {
    const before = targets.length;
    collectLoginTargets();
    if (targets.length !== before || !badge) {
      renderBadge();
    }
    if (pendingAutoFill && targets.length > 0) {
      pendingAutoFill = false;
      tryAutoFill();
    }
  }

  async function tryAutoFill() {
    if (!settings || settings.autofill !== "auto") {
      return;
    }
    collectLoginTargets();
    if (targets.length === 0) {
      pendingAutoFill = true;
      return;
    }
    const target = targets[0];
    const anyFilled = target.descriptors.some((d) => d.el.value);
    if (anyFilled) {
      return;
    }
    const res = await send({ type: "AUTOFILL_CHECK", url: location.href });
    if (!res || !res.ok || !res.result || !res.result.item) {
      return;
    }
    activeTarget = target;
    fillItem(res.result.item);
  }

  async function boot() {
    const status = await send({ type: "STATUS" });
    settings =
      (status && status.ok && status.result && status.result.settings) || null;
    const mode = settings ? settings.autofill : "prompt";
    if (mode === "off") {
      return;
    }
    scan();
    hookForms();
    tryAutoFill();
    send({ type: "PENDING_CAPTURE" }).then((res) => {
      if (res && res.ok && res.result && res.result.payload) {
        showSaveBanner(res.result.payload);
      }
    });

    let timer = null;
    const observer = new MutationObserver(() => {
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(scan, SCAN_DEBOUNCE);
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["type", "style", "hidden"],
    });
    window.addEventListener(
      "resize",
      () => {
        closeAccountMenu();
        renderBadge();
      },
      { passive: true },
    );
    window.addEventListener(
      "scroll",
      () => {
        closeAccountMenu();
        renderBadge();
      },
      {
        passive: true,
        capture: true,
      },
    );
    window.addEventListener("focusin", (ev) => {
      const el = ev.target;
      if (el && el.tagName === "INPUT" && isFillableInput(el)) {
        currentAnchorInput = el;
        window.setTimeout(() => {
          renderBadge(el);
        }, 40);
      } else {
        closeAccountMenu();
        if (el && (el.tagName === "SELECT" || el.tagName === "BUTTON")) {
          if (badge) {
            badge.remove();
            badge = null;
          }
        }
      }
    });
    document.addEventListener(
      "mousedown",
      (ev) => {
        if (accountMenu && host && !host.contains(ev.target)) {
          closeAccountMenu();
        }
      },
      true,
    );
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        closeAccountMenu();
      }
    });
  }

  window.addEventListener(
    "message",
    (ev) => {
      if (ev.source !== (frame && frame.contentWindow)) {
        return;
      }
      const data = ev.data;
      if (!data || data.source !== FRAME_MSG) {
        return;
      }
      if (data.type === "CLOSE") {
        closePicker(false);
        return;
      }
      if (data.type === "FILLED") {
        closePicker(false);
      }
    },
    false,
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.source !== MSG) {
      return false;
    }
    if (msg.type === "SHOW_SAVE_PROMPT") {
      showSaveBanner(msg.payload);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "OPEN_PICKER") {
      collectLoginTargets();
      openPicker(targets[0] || null, "center");
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "FILL_NOW") {
      const done = fillItem(msg.item);
      sendResponse({ ok: true, filled: done });
      return false;
    }
    if (msg.type === "SCAN") {
      scan();
      sendResponse({ ok: true, count: targets.length });
      return false;
    }
    if (msg.type === "LOCKED") {
      closePicker(true);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
