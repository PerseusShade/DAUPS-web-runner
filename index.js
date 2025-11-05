const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js";

let pyodide = null;
let inputQueue = [];
let runInProgress = false;

const $ = sel => document.querySelector(sel);
const appendOutput = (s) => {
    const out = $("#output");
    out.textContent += String(s);
    const term = $("#terminal");
    term.scrollTop = term.scrollHeight;
};

const setStatus = (s) => {
    $("#status").textContent = s;
};

async function loadPyodideAndPackages() {
    setStatus("Loading Pyodide...");
    if (!window.loadPyodide) {
        await import(PYODIDE_URL);
    }
    pyodide = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/" });
    setStatus("Pyodide loaded, loading interpreter...");

    const resp = await fetch("basic.py");
    const basicSrc = await resp.text();

    function js_write(s) {
        appendOutput(String(s));
    }

    function js_get_input_from_queue() {
        if (inputQueue.length === 0) return null;
        return inputQueue.shift();
    }

    async function js_await_input(prompt = "") {
        try {
            showInputLine(prompt);
        } catch (e) {}

        const value = await new Promise((resolve) => {
            const check = () => {
                if (inputQueue.length > 0) {
                    resolve(inputQueue.shift());
                } else {
                    setTimeout(check, 50);
                }
            };
            check();
        });

        try {
            hideInputLine();
        } catch (e) {}

        return value;
    }

    pyodide.globals.set("__js_write", js_write);
    pyodide.globals.set("__js_get_input", js_get_input_from_queue);
    pyodide.globals.set("__js_await_input", js_await_input);

    await pyodide.runPythonAsync(basicSrc);

    setStatus("Interpreter ready");
    $("#runBtn").disabled = false;
}

function pushInput(value) {
    inputQueue.push(value);
}

function clearTerminal() {
    $("#output").textContent = "";
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

function updateBlockCaret() {
    const block = $("#block-caret");
    const cmd = $("#cmd-line");
    const term = $("#terminal");

    if ($("#input-line").classList.contains("hidden")) {
        block.style.display = "none";
        return;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
        placeCaretAtEndContentEditable(cmd);
    }

    let range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    if (!range) {
        range = document.createRange();
        range.selectNodeContents(cmd);
        range.collapse(false);
    }
    if (!range.collapsed) {
        range.collapse(false);
    }

    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    range.insertNode(marker);

    const markerRect = marker.getBoundingClientRect();
    const termRect = term.getBoundingClientRect();

    const left = markerRect.left - termRect.left;
    const top = markerRect.top - termRect.top;

    block.style.display = "inline-block";
    block.style.left = `${Math.max(0, Math.round(left))}px`;
    block.style.top = `${Math.max(0, Math.round(top))}px`;

    marker.parentNode.removeChild(marker);

    placeCaretAtEndContentEditable(cmd);
}

function showInputLine(promptText = "") {
    const out = $("#output");

    if (out.textContent.endsWith("\n")) {
        out.textContent = out.textContent.replace(/\n+$/, "");
    }

    const line = $("#input-line");
    $("#cmd-prefix").textContent = promptText;
    const cmd = $("#cmd-line");
    cmd.textContent = "";
    line.classList.remove("hidden");
    line.style.display = "inline-block";

    placeCaretAtEndContentEditable(cmd);
    requestAnimationFrame(updateBlockCaret);

    if (!showInputLine._listenersAdded) {
        document.addEventListener("selectionchange", () => {
            if (!$("#input-line").classList.contains("hidden")) updateBlockCaret();
        });
        cmd.addEventListener("input", updateBlockCaret);
        cmd.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                const val = cmd.textContent;
                pushInput(val);
                appendOutput(val + "\n");
                hideInputLine();
            } else if (ev.key === "Tab") {
                ev.preventDefault();
                document.execCommand('insertText', false, '        ');
                updateBlockCaret();
            } else {
                setTimeout(updateBlockCaret, 0);
            }
        });
        showInputLine._listenersAdded = true;
    }
}

function hideInputLine() {
    $("#input-line").classList.add("hidden");
    $("#cmd-prefix").textContent = "";
    $("#cmd-line").textContent = "";
    $("#block-caret").style.display = "none";
}

function wireTerminalTyping() {
    const term = $("#terminal");
    term.addEventListener("keydown", (ev) => {
        const line = $("#input-line");
        if (line.classList.contains("hidden")) return;

        if (ev.key === "Backspace") {
            ev.preventDefault();
            const s = $("#cmd-line").textContent;
            $("#cmd-line").textContent = s.slice(0, -1);
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            const val = $("#cmd-line").textContent;
            pushInput(val);
            appendOutput(val + "\n");
            hideInputLine();
        } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
            ev.preventDefault();
            $("#cmd-line").textContent += ev.key;
        }
    });

    term.addEventListener("click", () => term.focus());
}

async function handleRun() {
    if (!pyodide || runInProgress) return;
    runInProgress = true;
    $("#runBtn").disabled = true;
    setStatus("Running...");
    clearTerminal();
    hideInputLine();

    const code = $("#editor").value;

    try {
        inputQueue = [];

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
        $("#runBtn").disabled = false;
        setStatus("Ready");
    }
}

function wireUI() {
    $("#runBtn").addEventListener("click", handleRun);
    wireTerminalTyping();

    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.key.toLowerCase() === "i") {
            showInputLine();
        }
    });

    $("#terminal").addEventListener("dblclick", () => {
        if (!runInProgress) return;
        showInputLine();
    });

    $("#editor").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            handleRun();
        }
    });
}

window.addEventListener("DOMContentLoaded", async () => {
    wireUI();
    setStatus("Preparing...");
    await loadPyodideAndPackages();
    setStatus("Ready");
});
