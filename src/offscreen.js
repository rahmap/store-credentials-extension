// Dokumen offscreen: satu-satunya jalur tulis clipboard dari service worker.

function fallbackWrite(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function fallbackRead() {
  const ta = document.createElement("textarea");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  let text = "";
  try {
    if (document.execCommand("paste")) {
      text = ta.value;
    }
  } catch {
    text = "";
  }
  ta.remove();
  return text;
}

async function write(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* lanjut ke fallback */
  }
  return fallbackWrite(text);
}

async function read() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    /* lanjut ke fallback */
  }
  return fallbackRead();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== "vault-local-offscreen") {
    return false;
  }
  (async () => {
    try {
      if (msg.type === "WRITE") {
        const ok = await write(String(msg.text == null ? "" : msg.text));
        sendResponse({ ok, error: ok ? null : "execCommand copy gagal" });
        return;
      }
      if (msg.type === "CLEAR_IF_MATCH") {
        const current = await read();
        const readable = current !== "" || fallbackReadSupported();
        if (readable && current !== msg.expected) {
          sendResponse({
            ok: true,
            cleared: false,
            reason: "clipboard sudah diganti",
          });
          return;
        }
        const ok = await write("");
        sendResponse({ ok, cleared: ok });
        return;
      }
      if (msg.type === "PING") {
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "tipe tidak dikenal" });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  })();
  return true;
});

function fallbackReadSupported() {
  return typeof document.execCommand === "function";
}
