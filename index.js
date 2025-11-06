const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js";

let pyodide = null;
let inputQueue = [];
let inputWaiters = [];
let runInProgress = false;
let stopRequested = false;

const DOM = {
    terminal: null,
    output: null,
    runBtn: null,
    stopBtn: null,
    status: null,
    inputLine: null,
    cmdLine: null,
    blockCaret: null,
    cmdPrefix: null,
    editor: null,
    themeToggle: null,
    langSelect: null,
    downloadPaneBtn: null,
    paneFileInput: null,
    termBtn: null
};

const $ = sel => document.querySelector(sel);

const appendOutput = s => {
    const out = DOM.output;
    out.textContent += String(s);
    DOM.terminal.scrollTop = DOM.terminal.scrollHeight;
};

const setStatus = s => {
    if (DOM.status) DOM.status.textContent = s;
};

async function loadPyodideAndPackages() {
    setStatus("Loading Pyodide...");
    if (!window.loadPyodide) await import(PYODIDE_URL);
    pyodide = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/" });
    let interruptBuffer = null;
    if (typeof SharedArrayBuffer !== "undefined") {
    try {
        interruptBuffer = new Int32Array(new SharedArrayBuffer(4));
        pyodide.setInterruptBuffer(interruptBuffer);
        console.log("Interrupt buffer set");
    } catch (e) {
        console.warn("SharedArrayBuffer / setInterruptBuffer not available:", e);
        interruptBuffer = null;
    }
    } else {
    console.warn("SharedArrayBuffer not available in this environment");
    }

    window.__pyodide_interruptBuffer = interruptBuffer;
    setStatus("Pyodide loaded, loading interpreter...");
    const resp = await fetch("basic.py");
    const basicSrc = await resp.text();
    function js_write(s) {
        appendOutput(String(s));
    }
    async function js_await_input(prompt = "") {
        try { showInputLine(prompt); } catch (e) {}
        try {
            if (pyodide && typeof pyodide.checkInterrupt === "function") {
                pyodide.checkInterrupt();
            }
        } catch (e) {
            try { hideInputLine(); } catch (e2) {}
            throw e;
        }
        if (inputQueue.length > 0) {
            const v = inputQueue.shift();
            try { hideInputLine(); } catch (e) {}
            return v;
        }
        return await new Promise((resolve, reject) => {
             inputWaiters.push({ resolve, reject });
        }).then(value => {
            try { hideInputLine(); } catch (e) {}
            return value;
        });
    }
    pyodide.globals.set("__js_write", js_write);
    pyodide.globals.set("__js_await_input", js_await_input);
    try { pyodide.globals.set("__stop_requested", false); } catch (e) {}
    await pyodide.runPythonAsync(basicSrc);
    setStatus("Interpreter ready");
    if (DOM.runBtn) DOM.runBtn.disabled = false;
    if (DOM.stopBtn) DOM.stopBtn.disabled = true;
}

function pushInput(value) {
    if (inputWaiters.length > 0) {
        const waiter = inputWaiters.shift();
        try {
            waiter.resolve(value);
        } catch (e) {
            inputQueue.push(value);
        }
    } else {
        inputQueue.push(value);
    }
}

function rejectAllInputWaitersWithKeyboardInterrupt() {
    while (inputWaiters.length) {
        const waiter = inputWaiters.shift();
        try {
            if (waiter && typeof waiter.reject === 'function') {
                waiter.reject(new Error('KeyboardInterrupt'));
            } else if (typeof waiter === 'function') {
                waiter(Promise.reject(new Error('KeyboardInterrupt')));
            }
        } catch (e) {}
    }
    try { hideInputLine(); } catch(e) {}
}

function clearTerminal() {
    DOM.output.textContent = "";
}

function placeCaretAtEndContentEditable(el) {
    el.focus();
    if (typeof window.getSelection !== "undefined" && typeof document.createRange !== "undefined") {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

let lastSelectionUpdate = 0;
function updateBlockCaret() {
    const block = DOM.blockCaret;
    const cmd = DOM.cmdLine;
    const term = DOM.terminal;
    const inputLine = DOM.inputLine;

    if (!inputLine || inputLine.classList.contains("hidden")) {
        if (block) block.style.display = "none";
        return;
    }

    if (block) block.style.display = "inline-block";

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) placeCaretAtEndContentEditable(cmd);
    let range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    if (!range) {
        range = document.createRange();
        range.selectNodeContents(cmd);
        range.collapse(false);
    }
    if (!range.collapsed) range.collapse(false);

    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    range.insertNode(marker);
    const markerRect = marker.getBoundingClientRect();
    const termRect = term.getBoundingClientRect();
    const left = markerRect.left - termRect.left;
    const top = markerRect.top - termRect.top;
    block.style.left = `${Math.max(0, Math.round(left))}px`;
    block.style.top = `${Math.max(0, Math.round(top))}px`;
    marker.remove();

    placeCaretAtEndContentEditable(cmd);
    lastSelectionUpdate = performance.now();
}

function showInputLine(promptText = "") {
    const out = DOM.output;
    if (out.textContent.endsWith("\n")) out.textContent = out.textContent.replace(/\n+$/, "");
    const line = DOM.inputLine;
    DOM.cmdPrefix.textContent = promptText;
    const cmd = DOM.cmdLine;
    cmd.textContent = "";
    line.classList.remove("hidden");
    line.style.display = "inline-block";

    if (DOM.terminal) {
        DOM.terminal.setAttribute('aria-disabled', 'false');
    }

    if (DOM.blockCaret) {
        DOM.blockCaret.style.display = "inline-block";
    }

    placeCaretAtEndContentEditable(cmd);
    requestAnimationFrame(updateBlockCaret);

    if (!showInputLine._listenersAdded) {
        document.addEventListener("selectionchange", () => {
            if (DOM.inputLine && !DOM.inputLine.classList.contains("hidden")) updateBlockCaret();
        });
        cmd.addEventListener("input", updateBlockCaret);
        cmd.addEventListener("keydown", ev => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                const val = cmd.textContent;
                pushInput(val);
                appendOutput(val + "\n");
                hideInputLine();
            } else if (ev.key === "Tab") {
                ev.preventDefault();
                document.execCommand('insertText', false, '                ');
                updateBlockCaret();
            } else {
                setTimeout(updateBlockCaret, 0);
            }
        });
        showInputLine._listenersAdded = true;
    }
}

function hideInputLine() {
    DOM.inputLine.classList.add("hidden");
    DOM.cmdPrefix.textContent = "";
    DOM.cmdLine.textContent = "";

    if (DOM.blockCaret) DOM.blockCaret.style.display = "none";

    if (DOM.terminal) {
        DOM.terminal.setAttribute('aria-disabled', 'true');
        try { DOM.terminal.blur(); } catch (e) {}
    }
}


function wireTerminalTyping() {
    const term = DOM.terminal;
    if (!term) return;
    term.addEventListener("keydown", ev => {
        const line = DOM.inputLine;
        const cmd = DOM.cmdLine;

        if (!line || line.classList.contains("hidden")) {
            if (ev.ctrlKey && ev.key.toLowerCase() === "c") {
                ev.preventDefault();
                ev.stopPropagation();
                if (runInProgress) {
                    appendOutput("^C\n");
                    try { hideInputLine(); } catch(e) {}
                    requestStop();
                }
            }
            return;
        }

        if (ev.key === "Backspace") {
            ev.preventDefault();
            const s = cmd.textContent;
            cmd.textContent = s.slice(0, -1);
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            const val = cmd.textContent;
            pushInput(val);
            appendOutput(val + "\n");
            hideInputLine();
        } else if (ev.key === "Tab") {
            ev.preventDefault();
            document.execCommand('insertText', false, '                ');
            updateBlockCaret();
        } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
            ev.preventDefault();
            cmd.textContent += ev.key;
        } else if (ev.ctrlKey && ev.key.toLowerCase() === "c") {
            ev.preventDefault();
            ev.stopPropagation();
            if (runInProgress) {
                appendOutput("^C\n");
                try { hideInputLine(); } catch(e) {}
                requestStop();
            }
        } else {
            setTimeout(updateBlockCaret, 0);
        }
    });

    term.addEventListener("click", () => {
        if (DOM.inputLine && !DOM.inputLine.classList.contains("hidden")) {
            term.focus();
        } else {}
    });
}

function requestStop() {
    stopRequested = true;

    try { hideInputLine(); } catch (e) {}

    try {
        const ib = window.__pyodide_interruptBuffer;
        if (ib && ib.length > 0) {
            ib[0] = 2;
            if (pyodide && typeof pyodide.checkInterrupt === 'function') {
                try { pyodide.checkInterrupt(); } catch(e) {}
            }
        }
    } catch(e){ console.warn("interrupt buffer write failed", e); }

    try {
        if (pyodide && pyodide.globals) pyodide.globals.set("__stop_requested", true);
    } catch(e){}

    try {
        if (pyodide) pyodide.runPythonAsync("__stop_requested = True").catch(()=>{});
    } catch(e){}

    try {
        rejectAllInputWaitersWithKeyboardInterrupt();
    } catch (e) {}
}

function clearStopRequest() {
    stopRequested = false;
    try {
        if (pyodide && pyodide.globals) pyodide.globals.set("__stop_requested", false);
    } catch (e) {}
}

async function handleRun() {
    if (!pyodide || runInProgress) return;
    runInProgress = true;
    DOM.runBtn.disabled = true;
    if (DOM.stopBtn) DOM.stopBtn.disabled = false;
    setStatus("Running...");
    clearTerminal();
    hideInputLine();
    const code = DOM.editor.value;
    try {
        inputQueue = [];
        inputWaiters = [];
        clearStopRequest();
        try { if (pyodide && pyodide.globals) pyodide.globals.set("__stop_requested", false); } catch (e) {}
        const pyCode = `
result, error = await run_async('<web>', ${JSON.stringify(code)})
if error:
        try:
                __js_write(error.as_string())
        except Exception:
                print(error.as_string())
else:
        try:
                __js_write("\\n")
        except Exception:
                pass
`;
        await pyodide.runPythonAsync(pyCode);
    } catch (err) {
        appendOutput(`JS Error: ${err}\n`);
    } finally {
        runInProgress = false;
        DOM.runBtn.disabled = false;
        if (DOM.stopBtn) DOM.stopBtn.disabled = true;
        setStatus("Ready");
        try { if (pyodide && pyodide.globals) pyodide.globals.set("__stop_requested", false); } catch (e) {}
    }
}

function handleStop() {
    if (!runInProgress) return;
    setStatus("Stop requested...");
    appendOutput("\n\n");
    requestStop();
    if (DOM.stopBtn) DOM.stopBtn.disabled = true;
    try {
        if (pyodide && pyodide.globals && pyodide.globals.has && pyodide.globals.has("on_stop_requested")) {
            pyodide.runPythonAsync("on_stop_requested()").catch(()=>{});
        }
    } catch (e) {}
}

function wireUI() {
    if (DOM.runBtn) DOM.runBtn.addEventListener("click", handleRun);
    if (DOM.stopBtn) DOM.stopBtn.addEventListener("click", handleStop);
    wireTerminalTyping();
    document.addEventListener("keydown", e => {
        if (e.ctrlKey && e.key.toLowerCase() === "i") showInputLine();
    });
    if (DOM.terminal) {
        DOM.terminal.addEventListener("dblclick", (e) => {
            if (DOM.inputLine && !DOM.inputLine.classList.contains('hidden')) {
                DOM.terminal.focus();
            } else {
                e.preventDefault();
            }
        });
    }
    if (DOM.editor) {
        DOM.editor.addEventListener("keydown", e => {
            if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                handleRun();
            } else if (e.key === "Tab") {
                e.preventDefault();
                const start = DOM.editor.selectionStart;
                const end = DOM.editor.selectionEnd;
                DOM.editor.value = DOM.editor.value.substring(0, start) + "        " + DOM.editor.value.substring(end);
                DOM.editor.selectionStart = DOM.editor.selectionEnd = start + 4;
            }
        });
    }
}

function wireHeaderAndPaneControls() {
    const editorEl = DOM.editor;
    if (editorEl) {
        const current = editorEl.value || "";
        const suggestion = "Write your code here...";
        if (current.trim() === suggestion) editorEl.value = "";
        editorEl.setAttribute('placeholder', suggestion);
    }
    const applyTheme = mode => {
        if (mode === 'dark') {
            document.documentElement.classList.add('dark');
            if (DOM.themeToggle) DOM.themeToggle.checked = true;
        } else {
            document.documentElement.classList.remove('dark');
            if (DOM.themeToggle) DOM.themeToggle.checked = false;
        }
    };
    try {
        const saved = localStorage.getItem('daups_theme');
        if (saved) applyTheme(saved);
        else applyTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    } catch (e) {}
    if (DOM.themeToggle) {
        DOM.themeToggle.addEventListener('change', ev => {
            const mode = ev.target.checked ? 'dark' : 'light';
            applyTheme(mode);
            try { localStorage.setItem('daups_theme', mode); } catch (e) {}
        });
    }
    if (DOM.langSelect) {
        DOM.langSelect.addEventListener('change', ev => {
            const v = ev.target.value;
            if (v) location.href = v + '.html';
        });
    }
    function saveAsFile(content, filename = 'code.daups') {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }
    if (DOM.downloadPaneBtn) {
        DOM.downloadPaneBtn.addEventListener('click', () => {
            if (!editorEl) return;
            const content = editorEl.value || "";
            const firstLine = (content.split(/\r?\n/).find(l => l.trim().length > 0) || '').trim();
            const safeName = firstLine ? firstLine.replace(/[^a-z0-9_\-]/ig, '_').slice(0, 40) : '';
            const filename = (safeName ? safeName + '.daups' : 'code.daups');
            saveAsFile(content, filename);
        });
    }
    if (DOM.paneFileInput) {
        DOM.paneFileInput.addEventListener('change', ev => {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;
            const name = file.name.toLowerCase();
            if (!(name.endsWith('.daups') || name.endsWith('.txt'))) {
                alert('Format non supporté — choisissez un fichier .daups ou .txt');
                DOM.paneFileInput.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = e => {
                const text = e.target.result || "";
                if (editorEl) {
                    editorEl.value = text;
                    editorEl.focus();
                    setStatus(`Fichier chargé : ${file.name}`);
                }
                DOM.paneFileInput.value = '';
            };
            reader.onerror = () => {
                alert('Erreur de lecture du fichier');
                DOM.paneFileInput.value = '';
            };
            reader.readAsText(file, 'utf-8');
        });
    }
    if (DOM.termBtn) {
        DOM.termBtn.addEventListener('click', () => {
            if (DOM.output) DOM.output.textContent = '';
            setStatus('Terminal vidé');
        });
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    DOM.terminal = $("#terminal");
    DOM.output = $("#output");
    DOM.runBtn = $("#runBtn");
    DOM.stopBtn = $("#stopBtn");
    DOM.status = $("#status");
    DOM.inputLine = $("#input-line");
    DOM.cmdLine = $("#cmd-line");
    DOM.blockCaret = $("#block-caret");
    DOM.cmdPrefix = $("#cmd-prefix");
    DOM.editor = document.getElementById("editor");
    DOM.themeToggle = document.getElementById('theme-toggle');
    DOM.langSelect = document.getElementById('lang-select');
    DOM.downloadPaneBtn = document.querySelector('.download-pane');
    DOM.paneFileInput = document.querySelector('.pane-file-input');
    DOM.termBtn = document.querySelector('.terminal-action');
    wireUI();
    wireHeaderAndPaneControls();
    setStatus("Preparing...");
    await loadPyodideAndPackages();
    setStatus("Ready");
});
