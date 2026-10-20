(function () {
"use strict";
const CFG = window.RT_CONFIG, ROSTER = window.RT_ROSTER;
const LAST_KEY = CFG.STORAGE_PREFIX + "last";

// ---------- проверка ----------
function normalize(s) {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => {
      const indentMatch = line.match(/^[ \t]*/);
      const indent = (indentMatch ? indentMatch[0] : "").replace(/\t/g, "  ");
      let body = line.slice(indentMatch ? indentMatch[0].length : 0).replace(/[ \t]+$/g, "");
      body = body
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\(\s*/g, "(")
        .replace(/\s*\)\s*/g, ")")
        .replace(/\s*,\s*/g, ", ")
        .replace(/\s*:\s*$/g, ":")
        .replace(/\s*=\s*/g, "=");
      return body === "" ? "" : indent + body;
    })
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
  return h;
}

let SALT = "";
function canonicalCalc(ch, value) {
  if (ch.num) {
    const cleaned = String(value).replace(/,/g, ".").replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || isNaN(parseFloat(cleaned))) return null;
    return String(parseFloat(cleaned));
  }
  return String(value).trim().toLowerCase().replace(/ё/g, "е");
}

function checkChallenge(ch, value) {
  if (ch.type === "code") return normalize(value) === normalize(ch.code);
  const c = canonicalCalc(ch, value);
  if (c === null) return false;
  return ch.h.indexOf(simpleHash(SALT + c)) !== -1;
}

function noteFor(ch, value) {
  if (ch.type === "code") return ch.note;
  const c = canonicalCalc(ch, value);
  if (c === null) return "";
  const k = SALT + c, idx = ch.h.indexOf(simpleHash(k));
  if (idx === -1) return "";
  return ch.en[idx].map((n, i) => String.fromCharCode(n ^ k.charCodeAt(i % k.length))).join("");
}

function sourceIsTrusted() { return location.hostname === CFG.EXPECTED_HOST; }

function integritySnapshot() {
  try { return simpleHash(checkChallenge.toString() + normalize.toString() + sourceIsTrusted.toString() + canonicalCalc.toString()); }
  catch (e) { return null; }
}
const INTEGRITY_BASELINE = integritySnapshot();
function integrityOk() { const c = integritySnapshot(); return c === null || c === INTEGRITY_BASELINE; }

// ---------- загрузка данных студента ----------
let DATA = null, PARTS = [], ALL = [], TOTAL = 0, FINAL_INDEX = 0, DISC = null, STUDENT = null;

window.RT_DATA = function (id, b64) {
  try {
    const bin = atob(b64), key = new TextEncoder().encode("ithub-rt|" + id);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key[i % key.length];
    const obj = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    if (pendingLoad && pendingLoad.id === id) pendingLoad.resolve(obj);
  } catch (e) { if (pendingLoad) pendingLoad.reject(e); }
};
let pendingLoad = null;
function loadStudent(id) {
  return new Promise((resolve, reject) => {
    pendingLoad = { id, resolve, reject };
    const s = document.createElement("script");
    s.src = "js/data/" + id + ".js?v=1";
    s.onerror = () => reject(new Error("load"));
    document.body.appendChild(s);
  });
}

// ---------- состояние ----------
function defaultState() {
  return { done: {}, answers: {}, timings: {}, attempts: {}, suspicious: {}, startTimes: {}, current: 0, autoSubmitted: false, tampered: false };
}
let state = defaultState();
function storageKey() { return CFG.STORAGE_PREFIX + STUDENT.id; }
function save() { try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch (e) {} }
function loadState() {
  state = defaultState();
  try { const s = JSON.parse(localStorage.getItem(storageKey()) || "null"); if (s) state = Object.assign(defaultState(), s); } catch (e) {}
}

let keydownCounts = {};
function bumpKeydown(key) { keydownCounts[key] = (keydownCounts[key] || 0) + 1; }
setInterval(() => { if (STUDENT && !integrityOk() && !state.tampered) { state.tampered = true; save(); } }, 3000);

function solvedCount() { return ALL.filter(c => state.done[c.key]).length; }
function partDone(pi) { return PARTS[pi].challenges.every(c => state.done[c.key]); }
function partUnlocked(pi) { for (let i = 0; i < pi; i++) if (!partDone(i)) return false; return true; }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + String(s).padStart(2, "0"); }

// ---------- защита от копирования ----------
function isField(t) { return t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT"); }
document.addEventListener("copy", e => { if (!isField(e.target)) e.preventDefault(); });
document.addEventListener("cut", e => { if (!isField(e.target)) e.preventDefault(); });
document.addEventListener("contextmenu", e => { if (!isField(e.target)) e.preventDefault(); });
document.addEventListener("dragstart", e => { if (!isField(e.target)) e.preventDefault(); });
document.addEventListener("selectstart", e => { if (!isField(e.target)) e.preventDefault(); });
document.addEventListener("keydown", e => {
  const k = (e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === "u" || k === "s" || k === "p" || ((k === "c" || k === "a" || k === "x") && !isField(e.target)))) e.preventDefault();
  if (k === "f12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === "i" || k === "j" || k === "c"))) e.preventDefault();
});

// ---------- экран выбора ----------
let selDisc = null;
function renderGate() {
  const box = document.getElementById("g-disc");
  box.innerHTML = ROSTER.disciplines.map(d =>
    `<div class="disc-opt" data-k="${d.key}"><b>${esc(d.code)} ${esc(d.title)}</b><small>${esc(d.list)} · пересдача · ${d.students.length} студентов</small></div>`).join("");
  box.querySelectorAll(".disc-opt").forEach(el => el.onclick = () => {
    selDisc = ROSTER.disciplines.find(d => d.key === el.dataset.k);
    box.querySelectorAll(".disc-opt").forEach(x => x.classList.toggle("sel", x === el));
    const sel = document.getElementById("g-student");
    sel.disabled = false;
    sel.innerHTML = '<option value="">— выберите свою фамилию —</option>' + selDisc.students.map(s => `<option value="${s.id}">${esc(s.fio)}</option>`).join("");
  });
}
document.getElementById("g-start").onclick = () => {
  const id = document.getElementById("g-student").value;
  if (!selDisc || !id) { document.getElementById("g-err").textContent = "Выберите дисциплину и свою фамилию."; return; }
  if (!confirm("Вы — " + selDisc.students.find(s => s.id === id).fio + "?\nПрактикум будет засчитан на это имя.")) return;
  try { localStorage.setItem(LAST_KEY, id); } catch (e) {}
  openStudent(id);
};
document.getElementById("btn-exit").onclick = () => {
  if (!confirm("Вернуться к выбору студента? Прогресс этого студента сохранится в браузере.")) return;
  try { localStorage.removeItem(LAST_KEY); } catch (e) {}
  location.reload();
};

function openStudent(id) {
  for (const d of ROSTER.disciplines) { const s = d.students.find(x => x.id === id); if (s) { DISC = d; STUDENT = s; } }
  if (!STUDENT) { try { localStorage.removeItem(LAST_KEY); } catch (e) {} return; }
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("main").innerHTML = '<div class="loading">Загрузка заданий…</div>';
  loadStudent(id).then(obj => {
    DATA = obj; SALT = "rt|" + id + "|"; PARTS = obj.parts; ALL = [];
    PARTS.forEach((p, pi) => p.challenges.forEach((ch, ci) => { ch.key = p.id + "-" + ci; ch.label = (pi + 1) + "." + (ci + 1); ALL.push(ch); }));
    TOTAL = ALL.length; FINAL_INDEX = PARTS.length;
    loadState();
    document.getElementById("h-title").textContent = "Пересдача · " + DISC.code + " " + DISC.title;
    document.getElementById("who").textContent = STUDENT.fio + " · предметная область: " + DATA.domain + " (" + DATA.area + ")";
    render();
  }).catch(() => { document.getElementById("main").innerHTML = '<div class="loading">Не удалось загрузить задания. Обновите страницу.</div>'; });
}

// ---------- рендер ----------
function renderNav() {
  const nav = document.getElementById("nav");
  let h = "";
  PARTS.forEach((p, pi) => {
    const cls = ["navitem"]; if (pi === state.current) cls.push("active");
    if (partDone(pi)) cls.push("done"); if (!partUnlocked(pi)) cls.push("locked");
    h += `<div class="${cls.join(" ")}" data-p="${pi}"><span class="n">${partDone(pi) ? "✓" : pi + 1}</span><span>${esc(p.title)}</span></div>`;
  });
  const fcls = ["navitem"]; if (state.current === FINAL_INDEX) fcls.push("active");
  fcls.push(solvedCount() === TOTAL ? "done" : "locked");
  h += `<div class="${fcls.join(" ")}" data-p="${FINAL_INDEX}"><span class="n">★</span><span>Итог и отчёт</span></div>`;
  nav.innerHTML = h;
  nav.querySelectorAll(".navitem").forEach(el => el.onclick = () => {
    const pi = +el.dataset.p;
    if (pi === FINAL_INDEX ? solvedCount() !== TOTAL : !partUnlocked(pi)) return;
    state.current = pi; save(); render(); window.scrollTo(0, 0);
  });
  const s = solvedCount();
  document.getElementById("pfill").style.width = (100 * s / TOTAL) + "%";
  document.getElementById("plbl").textContent = "Решено " + s + " из " + TOTAL;
}

const KIND = { code: "практика", calc: "расчёт / ответ", choice: "вопрос" };
function challengeHTML(ch) {
  const solved = !!state.done[ch.key];
  let h = `<div class="ch${solved ? " solved" : ""}" id="ch-${ch.key}">
    <div class="ch-head"><span class="ch-num">Задание ${ch.label}</span><span class="ch-kind">${KIND[ch.type]}</span><span class="ch-title">${esc(ch.title)}</span>${solved ? '<span class="ok-badge">✓ выполнено</span>' : ""}</div>
    <div class="why-box"><b>Зачем это нужно.</b> ${esc(ch.why)}</div>`;
  if (ch.type === "calc") {
    h += `<div class="question">${esc(ch.question)}</div>
      <input type="text" class="calc" id="in-${ch.key}" autocomplete="off" spellcheck="false" ${solved ? "disabled" : ""} value="${solved ? esc(state.answers[ch.key] || "") : ""}">`;
  } else if (ch.type === "choice") {
    h += `<div class="question">${esc(ch.question)}</div><div class="opts" id="in-${ch.key}">` +
      ch.options.map((o, i) => {
        const checked = solved && state.answers[ch.key] === o;
        return `<label class="opt${checked ? " sel" : ""}${solved ? " dis" : ""}"><input type="radio" name="r-${ch.key}" value="${i}" ${checked ? "checked" : ""} ${solved ? "disabled" : ""}><span>${esc(o)}</span></label>`;
      }).join("") + `</div>`;
  } else {
    h += `<div class="fname">${esc(ch.filename || "")}</div>
      <div class="codebox">${esc(ch.code)}</div>
      <textarea class="answer" id="in-${ch.key}" rows="${Math.max(4, ch.code.split("\n").length + 1)}" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Наберите код вручную — вставка отключена. Tab вставляет 2 пробела." ${solved ? "disabled" : ""}>${solved ? esc(state.answers[ch.key] || "") : ""}</textarea>`;
  }
  if (!solved) h += `<div class="row"><button class="btn" data-check="${ch.key}">Проверить</button><span class="fb" id="fb-${ch.key}"></span></div>`;
  if (solved) h += `<div class="note-box"><b>Разбор.</b> ${esc(noteFor(ch, state.answers[ch.key] || ""))}</div>`;
  return h + "</div>";
}

function render() {
  renderNav();
  const main = document.getElementById("main");
  if (state.current === FINAL_INDEX) { renderFinal(main); return; }
  if (!partUnlocked(state.current)) state.current = 0;
  const pi = state.current, p = PARTS[pi];
  let h = `<div class="card"><span class="part-tag">ЧАСТЬ ${pi + 1} ИЗ ${PARTS.length}</span><h2>${esc(p.title)}</h2>${p.intro}</div>`;
  for (const ch of p.challenges) {
    h += challengeHTML(ch);
    if (!state.done[ch.key]) {
      if (!state.startTimes[ch.key]) { state.startTimes[ch.key] = Date.now(); save(); }
      break;
    }
  }
  if (partDone(pi)) {
    const last = pi === PARTS.length - 1;
    h += `<div class="next-wrap"><button class="btn" id="btn-next">${last ? "К итогу и отчёту →" : "Следующая часть →"}</button></div>`;
  }
  main.innerHTML = h;
  main.querySelectorAll("[data-check]").forEach(b => b.onclick = () => onCheck(b.dataset.check));
  main.querySelectorAll("textarea.answer, input.calc").forEach(el => {
    const key = el.id.slice(3);
    el.addEventListener("keydown", e => {
      if (e.isTrusted) bumpKeydown(key);
      if (el.tagName === "INPUT" && e.key === "Enter") { e.preventDefault(); onCheck(key); }
      if (el.tagName === "TEXTAREA" && e.key === "Tab") {
        e.preventDefault();
        const s = el.selectionStart, en = el.selectionEnd;
        el.value = el.value.slice(0, s) + "  " + el.value.slice(en);
        el.selectionStart = el.selectionEnd = s + 2;
      }
    });
    ["paste", "drop"].forEach(t => el.addEventListener(t, e => e.preventDefault()));
    el.addEventListener("beforeinput", e => {
      if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop" || e.inputType === "insertFromPasteAsQuotation" || e.inputType === "insertReplacementText") e.preventDefault();
    });
  });
  main.querySelectorAll(".opts").forEach(box => box.querySelectorAll("input").forEach(inp => inp.addEventListener("change", () => {
    box.querySelectorAll(".opt").forEach(o => o.classList.toggle("sel", o.querySelector("input").checked));
  })));
  const nb = document.getElementById("btn-next");
  if (nb) nb.onclick = () => { state.current = pi + 1; save(); render(); window.scrollTo(0, 0); };
}

function firstDiffLine(a, b) {
  const x = normalize(a).split("\n"), y = normalize(b).split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i + 1;
  return 0;
}

function onCheck(key) {
  const ch = ALL.find(c => c.key === key);
  const fb = document.getElementById("fb-" + key);
  let value;
  if (ch.type === "choice") {
    const picked = document.querySelector(`input[name="r-${key}"]:checked`);
    if (!picked) { fb.className = "fb bad"; fb.textContent = "Выберите вариант ответа."; return; }
    value = ch.options[+picked.value];
  } else value = document.getElementById("in-" + key).value;
  if (!String(value).trim()) { fb.className = "fb bad"; fb.textContent = "Поле пустое."; return; }
  if (!integrityOk() && !state.tampered) { state.tampered = true; save(); }
  if (checkChallenge(ch, value)) {
    state.done[key] = true;
    state.answers[key] = value;
    state.timings[key] = Math.round((Date.now() - (state.startTimes[key] || Date.now())) / 1000);
    if (ch.type === "code") {
      const kd = keydownCounts[key] || 0;
      if (value.length > 15 && kd < value.length * 0.3) state.suspicious[key] = true;
    }
    save(); render();
    const done = document.getElementById("ch-" + key);
    if (done) done.scrollIntoView({ behavior: "smooth", block: "start" });
    const next = document.querySelector(".ch:not(.solved)") || document.getElementById("btn-next");
    if (next) setTimeout(() => next.scrollIntoView({ behavior: "smooth", block: "center" }), 900);
  } else {
    state.attempts[key] = (state.attempts[key] || 0) + 1; save();
    fb.className = "fb bad";
    if (ch.type === "choice") fb.textContent = "Неверно. Перечитайте теорию части и подумайте ещё.";
    else if (ch.type === "calc") fb.textContent = "Неверно. Перечитайте теорию части и пересчитайте.";
    else {
      const ln = firstDiffLine(value, ch.code);
      fb.textContent = "Не совпадает с образцом" + (ln ? " — первое расхождение в строке " + ln : "") + ". Проверьте символы, отступы и регистр.";
    }
  }
}

// ---------- отчёты ----------
function totalTime() { return ALL.reduce((s, c) => s + (state.timings[c.key] || 0), 0); }
function totalAttempts() { return ALL.reduce((s, c) => s + (state.attempts[c.key] || 0), 0); }
function flagsText() {
  const f = [];
  const susp = ALL.filter(c => state.suspicious[c.key]).map(c => c.label);
  if (susp.length) f.push("⚠ возможна вставка: " + susp.join(", "));
  if (!sourceIsTrusted()) f.push("⚠ ИЗМЕНЁННАЯ КОПИЯ (открыто с " + (location.hostname || "локального файла") + ")");
  if (state.tampered || !integrityOk()) f.push("⚠⚠ код проверки был изменён через консоль браузера");
  return f;
}
function label() { return "Пересдача " + DISC.code + " (" + DATA.domain + "): "; }
function buildCompact() {
  const s = solvedCount();
  return label() + [(s === TOTAL ? "Завершён" : "В процессе"), "время " + Math.round(totalTime() / 60) + " мин", "ошибочных попыток " + totalAttempts()].concat(flagsText()).join("; ");
}
function buildFull() {
  const lines = [
    "ПЕРЕСДАЧА · " + DISC.code + " " + DISC.title + " — отчёт",
    "Студент: " + STUDENT.fio,
    "Предметная область: " + DATA.domain + " (" + DATA.area + ")",
    "Решено заданий: " + solvedCount() + " из " + TOTAL,
    "Суммарное время на задания: " + fmtDur(totalTime()),
    "Ошибочных попыток всего: " + totalAttempts(),
    "Источник страницы: " + (sourceIsTrusted() ? "OK" : "⚠ ИЗМЕНЁННАЯ КОПИЯ (открыто с " + (location.hostname || "локального файла") + ")"),
    "Целостность проверки: " + ((state.tampered || !integrityOk()) ? "⚠⚠ код проверки был изменён через консоль браузера" : "OK"),
    "Сформирован: " + new Date().toLocaleString("ru-RU"),
    "----------------------------------------"
  ];
  PARTS.forEach((p, pi) => {
    lines.push("Часть " + (pi + 1) + ". " + p.title);
    p.challenges.forEach(c => {
      if (state.done[c.key]) lines.push("  " + c.label + " " + c.title + " — ✓ " + fmtDur(state.timings[c.key]) + ", ошибок " + (state.attempts[c.key] || 0) + (state.suspicious[c.key] ? ", ⚠ возможна вставка" : ""));
      else lines.push("  " + c.label + " " + c.title + " — не решено" + (state.attempts[c.key] ? " (ошибок " + state.attempts[c.key] + ")" : ""));
    });
  });
  return lines.join("\n");
}

function submitToGoogle() {
  let iframe = document.getElementById("gf-sink");
  if (!iframe) { iframe = document.createElement("iframe"); iframe.name = "gf-sink"; iframe.id = "gf-sink"; iframe.style.display = "none"; document.body.appendChild(iframe); }
  const form = document.createElement("form");
  form.action = CFG.GOOGLE_FORM_ACTION; form.method = "POST"; form.target = "gf-sink"; form.style.display = "none";
  const add = (n, v) => { const i = document.createElement("input"); i.type = "hidden"; i.name = n; i.value = v; form.appendChild(i); };
  const E = CFG.GOOGLE_FORM_ENTRIES;
  add(E.name, STUDENT.fio);
  add(E.group, "Пересдача " + DISC.code);
  add(E.status, buildCompact());
  add(E.tasks, solvedCount() + " из " + TOTAL);
  document.body.appendChild(form);
  form.submit();
  setTimeout(() => form.remove(), 2000);
}

function renderFinal(main) {
  let sendMsg;
  if (!state.autoSubmitted) {
    try { submitToGoogle(); sendMsg = "✓ Отчёт отправлен преподавателю."; } catch (e) { sendMsg = "Не удалось отправить автоматически — скопируйте отчёт и отправьте преподавателю."; }
    state.autoSubmitted = true; save();
  } else sendMsg = "✓ Отчёт уже был отправлен преподавателю. Если нужно, скопируйте подробный отчёт ниже.";
  main.innerHTML = `<div class="card"><span class="part-tag">ИТОГ</span><h2>Практикум пересдачи пройден</h2>
    <p>Вы прошли все ${TOTAL} заданий для проекта <b>${esc(DATA.domain)}</b> (${esc(DATA.area)}) по всем темам дисциплины «${esc(DISC.title)}».</p>
    <div class="callout note">На пересдаче будьте готовы устно объяснить любой файл и любой расчёт: зачем он нужен, что делает каждая строка и как изменится результат при других числах.</div>
    <div class="send-status"><b>${esc(sendMsg)}</b></div>
    <pre class="report" id="final-report">${esc(buildFull())}</pre>
    <div class="row"><button class="btn" id="final-copy">Скопировать отчёт</button><span class="fb" id="final-fb"></span></div></div>`;
  document.getElementById("final-copy").onclick = () => copyText(buildFull(), "final-fb");
}

function copyText(text, fbId) {
  const fb = document.getElementById(fbId);
  const ok = () => { fb.className = "fb good"; fb.textContent = "Скопировано"; };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => { fb.className = "fb bad"; fb.textContent = "Не удалось скопировать — выделите текст вручную"; });
  else { fb.className = "fb bad"; fb.textContent = "Буфер обмена недоступен"; }
}

document.getElementById("btn-report").onclick = () => {
  document.getElementById("modal-report").textContent = buildFull();
  document.getElementById("modal-fb").textContent = "";
  document.getElementById("modal").classList.remove("hidden");
};
document.getElementById("modal-close").onclick = () => document.getElementById("modal").classList.add("hidden");
document.getElementById("modal-copy").onclick = () => copyText(buildFull(), "modal-fb");

// ---------- старт ----------
renderGate();
let last = null;
try { last = localStorage.getItem(LAST_KEY); } catch (e) {}
if (last) openStudent(last);
})();
