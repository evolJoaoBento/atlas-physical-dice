/*
 * Drives the real Obsidian over the Chrome DevTools Protocol.
 *
 * Obsidian is Electron, so when it is launched with
 * `--remote-debugging-port=9222` its renderer is a debuggable page like any
 * other. Attaching to it means there is no stub, no replica and no fidelity gap
 * to argue about: it is the actual app, the actual plugin, the actual settings
 * modal, with the real vault behind it.
 *
 * Launch Obsidian with the port first:
 *   Stop-Process -Name obsidian; & "$env:LOCALAPPDATA\Obsidian\Obsidian.exe" --remote-debugging-port=9222
 *
 * Then:
 *   node harness/obsidian-cdp.mjs eval "app.plugins.plugins["atlas-physical-dice"].settings.diceSize"
 *   node harness/obsidian-cdp.mjs eval-file probe.js
 *   node harness/obsidian-cdp.mjs shot out.png
 *   node harness/obsidian-cdp.mjs click 240 195
 *   node harness/obsidian-cdp.mjs drag 100 100 400 300
 *   node harness/obsidian-cdp.mjs reload
 *
 * The debug port lets anything on this machine drive Obsidian. It is bound to
 * localhost, but close it when you are done by restarting Obsidian normally.
 */

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';

const PORT = Number(process.env.OBSIDIAN_CDP_PORT || 9222);
const HOST = '127.0.0.1';

/**
 * Where Obsidian is installed. The installer is per-user on Windows, so this is
 * the same for every normal install; OBSIDIAN_EXE overrides it.
 */
const OBSIDIAN_EXE =
    process.env.OBSIDIAN_EXE ||
    path.join(process.env.LOCALAPPDATA || '', 'Obsidian', 'Obsidian.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy, or give up. Returns what it returned. */
async function until(fn, timeoutMs, everyMs = 500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return value;
        if (Date.now() > deadline) return null;
        await sleep(everyMs);
    }
}

/** The debug port is answering AND an Obsidian window is attached to it. */
async function debugPageReady() {
    try {
        const res = await fetch(`http://${HOST}:${PORT}/json/list`, {
            signal: AbortSignal.timeout(1000)
        });
        if (!res.ok) return null;
        const targets = await res.json();
        return targets.find(
            (t) => t.type === 'page' && String(t.url).startsWith('app://obsidian.md')
        ) || null;
    } catch {
        return null;
    }
}

function obsidianRunning() {
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/FO', 'CSV'], {
            encoding: 'utf8'
        });
        return out.includes('Obsidian.exe');
    } catch {
        return false;
    }
}

/**
 * Ask Obsidian to close, then insist.
 *
 * The polite form is a window-close message, which lets it flush whatever it
 * has in hand and shut down the way it would if you clicked the X. Obsidian
 * writes notes as you type, so there is nothing unsaved to lose either way, but
 * there is no reason to be rough about it when waiting a second costs nothing.
 */
async function stopObsidian() {
    if (!obsidianRunning()) return 'not running';
    try {
        execFileSync('taskkill', ['/IM', 'Obsidian.exe'], { stdio: 'ignore' });
    } catch {
        // No window to close - fall through to the forced kill.
    }
    const gone = await until(async () => !obsidianRunning(), 8000, 250);
    if (gone) return 'closed';

    try {
        execFileSync('taskkill', ['/IM', 'Obsidian.exe', '/F'], { stdio: 'ignore' });
    } catch {
        // Already gone between the check and the kill.
    }
    await until(async () => !obsidianRunning(), 5000, 250);
    return 'killed';
}

/** Start Obsidian detached, with the port open. It reopens the last vault. */
function startObsidian() {
    if (!fs.existsSync(OBSIDIAN_EXE)) {
        throw new Error(
            `Obsidian not found at ${OBSIDIAN_EXE}. Set OBSIDIAN_EXE to its path.`
        );
    }
    spawn(OBSIDIAN_EXE, [`--remote-debugging-port=${PORT}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
    }).unref();
}

/**
 * Get to a state where the rest of this file can work, from whatever state the
 * machine is in: nothing running, running without the port, or already right.
 *
 * The point of this command is that driving Obsidian needs no human in the
 * loop. Everything else here assumes the port is open; this is what opens it.
 */
async function ensureObsidian({ restart = false } = {}) {
    if (!restart && (await debugPageReady())) return 'already on the debug port';

    const stopped = await stopObsidian();
    startObsidian();

    const page = await until(debugPageReady, 60000, 500);
    if (!page) {
        throw new Error(
            `Obsidian did not come up on port ${PORT} within 60s. ` +
            'It may have reopened a vault picker rather than a vault.'
        );
    }

    // A window on the port is not the same as a loaded plugin. Wait for the
    // plugin object, or the first eval after this lands on a half-built app.
    const loaded = await withSession(
        (send) =>
            until(
                async () => (await evaluate(send, 'return !!app.plugins.plugins["atlas-physical-dice"];')) === 'true',
                30000,
                500
            ),
        { autoEnsure: false }
    );

    return `${stopped} -> up on ${PORT}` + (loaded ? ', plugin loaded' : ', plugin NOT loaded');
}

async function mainTarget() {
    const res = await fetch(`http://${HOST}:${PORT}/json/list`);
    const targets = await res.json();
    const page = targets.find(
        (t) => t.type === 'page' && String(t.url).startsWith('app://obsidian.md')
    );
    if (!page) {
        throw new Error(
            'No Obsidian window found on the debug port. Is Obsidian running with ' +
            '--remote-debugging-port=' + PORT + '?'
        );
    }
    return page;
}

/**
 * Minimal CDP client: connect, run a sequence of commands, close.
 *
 * If the port is not open there is nothing to connect to and the only useful
 * thing to do is open it, so that is what happens — no human in the loop. Pass
 * `autoEnsure: false` from inside ensureObsidian(), which would otherwise
 * recurse into itself.
 */
async function withSession(fn, { autoEnsure = true } = {}) {
    if (autoEnsure && !(await debugPageReady())) {
        console.error(`[cdp] nothing on port ${PORT} - restarting Obsidian with it open`);
        await ensureObsidian();
    }
    const target = await mainTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 1;

    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
    });

    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });

    // Obsidian usually sits behind the terminal that is driving it, and Chromium
    // throttles a window it considers hidden: requestAnimationFrame stops
    // entirely and setTimeout is clamped to about once a second. Tests then fail
    // for reasons that have nothing to do with the code under test. These two
    // make the page behave as a focused, visible one no matter where it is.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});

    try {
        return await fn(send);
    } finally {
        ws.close();
    }
}

/**
 * Evaluate in the renderer. The expression is wrapped so top-level await works
 * and so the value comes back as JSON rather than a remote object handle.
 */
async function evaluate(send, expression) {
    const wrapped = `(async () => {
        const __v = await (async () => { ${expression} })();
        try { return JSON.stringify(__v, null, 1) ?? String(__v); }
        catch { return String(__v); }
    })()`;

    const result = await send('Runtime.evaluate', {
        expression: wrapped,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
    });

    if (result.exceptionDetails) {
        const e = result.exceptionDetails;
        throw new Error(e.exception?.description || e.text);
    }
    return result.result.value;
}

async function mouse(send, type, x, y, extra = {}) {
    await send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
        buttons: type === 'mouseReleased' ? 0 : 1,
        ...extra
    });
}

const [command, ...args] = process.argv.slice(2);

const commands = {
    async eval(send) {
        const expr = args.join(' ');
        // A bare expression is far commoner than a statement block.
        const body = /\breturn\b|;/.test(expr) ? expr : `return (${expr});`;
        return evaluate(send, body);
    },

    async 'eval-file'(send) {
        const file = args[0];
        if (!file) throw new Error('eval-file needs a path');
        return evaluate(send, fs.readFileSync(file, 'utf8'));
    },

    /** shot <file> [x y w h [scale]] — the clip is in CSS pixels. */
    async shot(send) {
        const out = path.resolve(args[0] || 'obsidian.png');
        // A backgrounded Chromium window throttles rAF to nothing, so anything
        // animated is frozen mid-motion until the window is brought forward.
        await send('Page.bringToFront').catch(() => {});

        const params = { format: 'png' };
        if (args.length >= 5) {
            const [x, y, width, height, scale] = args.slice(1).map(Number);
            params.clip = { x, y, width, height, scale: scale || 2 };
            params.captureBeyondViewport = true;
        }

        const { data } = await send('Page.captureScreenshot', params);
        fs.writeFileSync(out, Buffer.from(data, 'base64'));
        return `saved ${out}`;
    },

    async front(send) {
        await send('Page.bringToFront');
        return 'Obsidian brought to the front';
    },

    /**
     * bounds [width height] — resize the Obsidian window, or report its size.
     *
     * Worth having because a short or oddly shaped window silently changes what
     * a screenshot is worth: the tray is sized from the window, so the dice and
     * their shadows come out too small to judge.
     */
    async bounds(send) {
        const [width, height] = args.map(Number);
        // Electron does not expose CDP's Browser domain, so this goes through
        // the renderer's own remote handle to the BrowserWindow.
        return evaluate(send, `
            if (${Number.isFinite(width) && Number.isFinite(height)}) {
                const remote = require('electron').remote || require('@electron/remote');
                const win = remote.getCurrentWindow();
                win.unmaximize();
                win.setBounds({ x: 60, y: 60, width: ${width || 0}, height: ${height || 0} });
                await new Promise((r) => setTimeout(r, 400));
            }
            return { width: window.innerWidth, height: window.innerHeight };
        `);
    },

    /**
     * Drive the plugin's render loop by hand, for when the window cannot be
     * focused. Same trick as the browser harness: real animate(), synthetic
     * clock, so physics advances deterministically without waiting on rAF.
     */
    async pump(send) {
        const frames = Number(args[0] || 240);
        return evaluate(
            send,
            `
            const d = app.plugins.plugins["atlas-physical-dice"]?.dice;
            if (!d) return 'overlay closed';
            let settledAt = null;
            for (let i = 0; i < ${frames}; i++) {
                if (d.animationId !== null) { cancelAnimationFrame(d.animationId); d.animationId = null; }
                d.lastFrameTime = performance.now() - 1000 / 60;
                d.animate();
                if (settledAt === null &&
                    d.diceBodyArray.length &&
                    d.diceBodyArray.every((b) => b.sleepState === 2)) {
                    settledAt = i + 1;
                }
            }
            if (d.animationId !== null) { cancelAnimationFrame(d.animationId); d.animationId = null; }
            return {
                frames: ${frames},
                settledAfter: settledAt,
                sleep: d.diceBodyArray.map((b) => b.sleepState)
            };`
        );
    },

    async click(send) {
        const [x, y] = args.map(Number);
        await mouse(send, 'mouseMoved', x, y, { buttons: 0 });
        await mouse(send, 'mousePressed', x, y);
        await mouse(send, 'mouseReleased', x, y);
        return `clicked ${x},${y}`;
    },

    async drag(send) {
        const [x1, y1, x2, y2] = args.map(Number);
        await mouse(send, 'mouseMoved', x1, y1, { buttons: 0 });
        await mouse(send, 'mousePressed', x1, y1);
        // Several intermediate moves: one big jump reads as a teleport to any
        // handler that measures velocity, which the dice drag does.
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
            await mouse(send, 'mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
            await new Promise((r) => setTimeout(r, 16));
        }
        await mouse(send, 'mouseReleased', x2, y2);
        return `dragged ${x1},${y1} -> ${x2},${y2}`;
    },

    async key(send) {
        for (const ch of args.join(' ')) {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
        }
        return 'typed';
    },

    async reload(send) {
        // Obsidian's own reload keeps the vault; a raw Page.reload can wedge it.
        return evaluate(send, `app.commands.executeCommandById('app:reload'); return 'reloading';`);
    },

    async targets() {
        const res = await fetch(`http://${HOST}:${PORT}/json/list`);
        return JSON.stringify(await res.json(), null, 1);
    },

    /** Open the debug port if it is not already open. Safe to run repeatedly. */
    async ensure() {
        return ensureObsidian();
    },

    /** Restart even if the port is already open - picks up a rebuilt main.js. */
    async restart() {
        return ensureObsidian({ restart: true });
    },

    /** Close Obsidian, and with it the debug port. */
    async stop() {
        return stopObsidian();
    }
};

/** Commands that manage the process itself, so they must not need a session. */
const SESSIONLESS = new Set(['targets', 'ensure', 'restart', 'stop']);

if (!command || !commands[command]) {
    console.error(`usage: node harness/obsidian-cdp.mjs <${Object.keys(commands).join('|')}> [args]`);
    process.exit(1);
}

try {
    const out = SESSIONLESS.has(command)
        ? await commands[command]()
        : await withSession(commands[command]);
    console.log(out);
} catch (error) {
    console.error(`[cdp] ${error.message}`);
    process.exit(1);
}
