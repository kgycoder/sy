/* ════════════════════════════════════════════════════════════════
   lyric-word.js — Apple Music 스타일 단어/글자 단위 가사 하이라이트 엔진
   - 라인 데이터: line.w = [{s,e,t}] (초 단위). 없으면 기존 줄 단위 동작 그대로.
   - 활성 줄(+그 줄을 그리는 뷰)만 rAF 로 구동, 일시정지/백그라운드/탭 숨김이면 즉시 정지.
   - 매 프레임 "값이 바뀐 글자"만 DOM 에 쓰고, 읽기(layout)는 하지 않는다.
   - 활성 줄 주변의 줄만 글자 DOM 을 만들고 나머지는 순수 텍스트로 유지(DOM 최소화).
════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    const FEATHER = 0.42;     // 다음 글자가 미리 차오르기 시작하는 폭(글자 수) — 다음 단어 첫 글자도 살짝 채워짐
    const LEAD_IN = 0.16;     // 첫 글자 직전 예비 점등(초)
    const LIFT = 0.085;       // 글자 들림 높이(em)
    const T_LEAD = 0.05;      // 화면 표시 지연 보정(초)
    const KEYS = ['el', 'el_lv', 'el_fs'];
    const W = window.LW = {};
    const built = new Set();
    let cur = -1, raf = 0, lastT = -9;
    let _base = 0, _bNow = 0, _smp = -1e9;

    /* ── 재생 시간: 90ms 마다만 실제 플레이어를 읽고 그 사이는 보간 (YT 브릿지 호출 최소화) ── */
    W.now = function () {
        const n = performance.now();
        if (n - _smp > 90) {
            let s = 0;
            try { s = getPlayheadTime(); } catch (e) { }
            const pred = _base + (n - _bNow) / 1000;
            if (!S.playing || Math.abs(s - pred) > 0.35) _base = s;
            else _base = pred + (s - pred) * 0.2;
            _bNow = n; _smp = n;
        }
        return S.playing ? _base + (n - _bNow) / 1000 : _base;
    };

    const ss = (a, b, x) => { const u = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return u * u * (3 - 2 * u); };

    /* 글자별 길이 가중치 — 한글 받침/모음/문장부호를 구분해 발음 리듬에 가깝게 */
    function cw(ch) {
        const c = ch.charCodeAt(0);
        if (c >= 0xAC00 && c <= 0xD7A3) return ((c - 0xAC00) % 28) ? 1.35 : 1;
        if (/[aeiouyAEIOUY]/.test(ch)) return 1.3;
        if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(ch)) return 1.1;
        if (/[\p{L}\p{N}]/u.test(ch)) return 0.85;
        if (/\s/.test(ch)) return 0.1;
        return 0.3;
    }

    function model(line) {
        if (line._m) return line._m;
        const src = line.w, toks = [];
        for (const w of src) {
            const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(w.t);
            if (!m[2]) { if (toks.length) toks[toks.length - 1].tr = true; continue; }
            if (m[1] && toks.length) toks[toks.length - 1].tr = true;
            toks.push({ core: m[2], tr: !!m[3], s: w.s, e: w.e });
        }
        if (!toks.length) return null;
        let prevS = -1;
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i], nx = toks[i + 1];
            if (t.s < prevS) t.s = prevS;
            let e = (isFinite(t.e) && t.e > t.s) ? t.e : NaN;
            if (isNaN(e)) e = nx ? nx.s : Math.min(line.end || t.s + 2, t.s + 0.4 + 0.18 * Array.from(t.core).length);
            if (nx && e > nx.s) e = nx.s;
            if (e < t.s + 0.01) e = t.s + 0.01;
            t.e = e; prevS = t.s;
        }
        const words = [], kt = [toks[0].s - LEAD_IN], kx = [-FEATHER];
        let x = 0;
        for (const tk of toks) {
            const cs = Array.from(tk.core), n = cs.length;
            const wts = cs.map(cw); let tot = 0; for (const v of wts) tot += v;
            const dur = tk.e - tk.s;
            // 긴 단어는 시작을 빠르게, 끝을 느리게(늘여 부르는 모음) — 일정 속도의 기계적 진행 방지
            const a = Math.min(1, Math.max(0, (dur - 0.5) / 1.5)), p = 1 + 0.6 * a;
            let acc = 0;
            for (let j = 0; j <= n; j++) {
                kt.push(tk.s + dur * Math.pow(acc / tot, p)); kx.push(x + j);
                if (j < n) acc += wts[j];
            }
            words.push({ x0: x, n, s: tk.s, e: tk.e, dur, tr: tk.tr, cs, long: false });
            x += n;
        }
        const ds = words.map(w => w.dur).sort((a, b) => a - b);
        const med = ds[ds.length >> 1] || 0.3, longIdx = [];
        words.forEach((w, i) => { if (w.dur >= Math.max(0.95, 2 * med)) { w.long = true; longIdx.push(i); } });
        Object.defineProperty(line, '_m', {
            value: { words, n: x, kt, kx, ki: 0, vals: new Float32Array(x * 2).fill(-9), gl: new Float32Array(words.length), longIdx, dirty: true },
            writable: true, configurable: true, enumerable: false
        });
        return line._m;
    }

    function xAt(m, t) {
        const kt = m.kt, kx = m.kx, K = kt.length;
        if (t <= kt[0]) return kx[0];
        if (t >= kt[K - 1]) return kx[K - 1];
        let i = m.ki; if (i >= K - 1 || t < kt[i]) i = 0;
        while (i < K - 2 && t >= kt[i + 1]) i++;
        m.ki = i;
        const d = kt[i + 1] - kt[i];
        return d < 1e-6 ? kx[i + 1] : kx[i] + (kx[i + 1] - kx[i]) * ((t - kt[i]) / d);
    }

    function build(el, line) {
        const m = model(line); if (!m) return false;
        const frag = document.createDocumentFragment(), chars = [], wsp = [];
        for (const w of m.words) {
            const sp = document.createElement('span');
            sp.className = 'lw-w' + (w.long ? ' lw-long' : '');
            for (const ch of w.cs) {
                const c = document.createElement('span');
                c.className = 'lw-c'; c.textContent = ch;
                sp.appendChild(c); chars.push(c);
            }
            frag.appendChild(sp); wsp.push(sp);
            if (w.tr) frag.appendChild(document.createTextNode(' '));
        }
        el.textContent = ''; el.appendChild(frag);
        el._lw = { chars, wsp }; el.classList.add('lw');
        m.dirty = true;
        return true;
    }

    function unbuild(line) {
        for (const k of KEYS) {
            const el = line[k];
            if (el && el._lw) { el.textContent = line.text; el._lw = null; el.classList.remove('lw', 'lw-act'); }
        }
    }

    function setAct(line, on) {
        if (!line) return;
        const m = line._m;
        for (const k of KEYS) {
            const el = line[k];
            if (!el || !el._lw) continue;
            el.classList.toggle('lw-act', on);
            if (!on) {
                for (const c of el._lw.chars) c.style.transform = '';
                for (const sp of el._lw.wsp) sp.classList.remove('lw-gl');
            }
        }
        if (m) { m.ki = 0; m.gl.fill(0); m.vals.fill(-9); m.dirty = true; }
    }

    function views(line) {
        const out = [];
        for (const k of KEYS) { const el = line[k]; if (el && el._lw && el.isConnected) out.push(el); }
        return out;
    }

    function paint(line, t) {
        const m = line._m; if (!m) return;
        const els = views(line); if (!els.length) return;
        const tt = t + T_LEAD, X = xAt(m, tt), vals = m.vals, dirty = m.dirty;
        m.dirty = false;
        for (let k = 0; k < m.n; k++) {
            const f = ss(k - FEATHER, k + 1, X);          // 글자 내부 채움(0~1) — 다음 글자 앞부분이 미리 살짝 차오름
            const lf = ss(k - 0.15, k + 1.7, X);          // 들림(채움보다 살짝 늦게 올라가 부드럽게)
            const i2 = k * 2;
            if (!dirty) {
                const edge = (f === 0 || f === 1) && vals[i2] !== f;
                if (!edge && Math.abs(f - vals[i2]) < 0.006 && Math.abs(lf - vals[i2 + 1]) < 0.006) continue;
            }
            vals[i2] = f; vals[i2 + 1] = lf;
            const pv = (-20 + 140 * f).toFixed(1);
            const ty = lf > 0.001 ? 'translate3d(0,' + (-LIFT * lf).toFixed(3) + 'em,0)' : '';
            for (const e of els) {
                const c = e._lw.chars[k];
                if (c) { c.style.setProperty('--p', pv); c.style.transform = ty; }
            }
        }
        // 오래 끄는 단어: 채워지는 진행도에 맞춰 글로우가 점진적으로 켜지고, 단어가 끝나면 서서히 꺼짐
        for (const wi of m.longIdx) {
            const w = m.words[wi];
            let g = ss(0.02, 0.55, (X - w.x0) / w.n) * Math.min(1, 0.55 + w.dur * 0.2);
            if (tt > w.e) g *= 1 - ss(0, 1, (tt - w.e) / 0.5);
            g = Math.round(g * 30) / 30;
            if (g === m.gl[wi] && !dirty) continue;
            m.gl[wi] = g;
            for (const e of els) {
                const sp = e._lw.wsp[wi];
                if (sp) { sp.style.setProperty('--g', g); sp.classList.toggle('lw-gl', g > 0); }
            }
        }
    }

    function loop() {
        raf = 0;
        const line = LY.lines[cur];
        if (cur < 0 || !line || !line._m) return;
        const t = W.now();
        paint(line, t); lastT = t;
        if (S.playing && !document.hidden && !window.__bgMode) raf = requestAnimationFrame(loop);
    }

    /* 가사 틱(40ms)에서 호출: 재생 중이거나 시간이 바뀐 경우에만 프레임 예약 */
    W.ensure = function () {
        if (raf || cur < 0) return;
        const line = LY.lines[cur];
        if (!line || !line.w || document.hidden || window.__bgMode) return;
        if (S.playing || Math.abs(W.now() - lastT) > 0.02 || (line._m && line._m.dirty)) raf = requestAnimationFrame(loop);
    };

    W.reset = function () {
        if (raf) cancelAnimationFrame(raf);
        raf = 0; cur = -1; lastT = -9; built.clear();
    };

    /* 현재 줄이 바뀔 때(_highlightLine) */
    W.onLine = function (idx) {
        const L = LY.lines;
        if (cur >= 0 && cur !== idx && L[cur]) setAct(L[cur], false);
        cur = idx;
        for (const line of Array.from(built)) {
            const bi = L.indexOf(line);
            if (bi < 0 || idx < 0 || Math.abs(bi - idx) > 1) { unbuild(line); built.delete(line); }
        }
        const line = idx >= 0 ? L[idx] : null;
        if (!line || !line.w) return;
        for (const k of KEYS) { const el = line[k]; if (el && el.isConnected && !el._lw) build(el, line); }
        built.add(line);
        setAct(line, true);
        lastT = -9;
        W.ensure();
    };

    /* 줄 요소에 텍스트(또는 글자 DOM)를 채운다. 워드싱크 데이터가 없으면 textContent 와 동일 */
    W.fill = function (el, line) {
        el.textContent = line.text; el._lw = null;
        if (line.w && LY.curIdx >= 0 && LY.lines[LY.curIdx] === line && build(el, line)) {
            cur = LY.curIdx; built.add(line);
            el.classList.add('lw-act');
            line._m.vals.fill(-9); line._m.dirty = true; lastT = -9;
            W.ensure();
        }
    };
})();
