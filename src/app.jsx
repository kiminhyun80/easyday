import KoreanLunarCalendar from "korean-lunar-calendar"; // 한국천문연구원 기준 음력 (1000~2050년)
const { useState, useEffect, useMemo, useRef } = React;

// ── 저장소: 폰 내부(localStorage)에 저장 ──────────────
window.storage = {
  async get(k) { const v = localStorage.getItem(k); if (v === null) throw new Error("not found"); return { key: k, value: v }; },
  async set(k, v) { localStorage.setItem(k, v); return { key: k, value: v }; },
  async delete(k) { localStorage.removeItem(k); return { key: k, deleted: true }; },
};
// 백업 내보내기/가져오기
const BACKUP_KEYS = ["daycounter:entries", "daycounter:pin", "daycounter:holidays"];
function exportBackup() {
  const data = {}; for (const k of BACKUP_KEYS) { const v = localStorage.getItem(k); if (v !== null) data[k] = v; }
  const blob = new Blob([JSON.stringify({ app: "Easyday", exported: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `easyday-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
}
function importBackup(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { try { const j = JSON.parse(r.result); if (!j.data) throw new Error("형식이 달라요"); for (const [k, v] of Object.entries(j.data)) if (BACKUP_KEYS.includes(k)) localStorage.setItem(k, v); res(); } catch (e) { rej(e); } };
    r.onerror = rej; r.readAsText(file);
  });
}

// ── 카테고리 ──────────────────────────────────────────
const CATS = {
  me:     { label: "나",     color: "#2F6F5E", unitYear: "번째 생일", dayWord: "태어난지" },
  kid:    { label: "아이",   color: "#E5567A", unitYear: "돌",   dayWord: "태어난지" },
  friend: { label: "친구",   color: "#E39B2F", unitYear: "번째 생일", dayWord: "태어난지" },
  anniv:  { label: "기념일", color: "#8B4FB6", unitYear: "주년", dayWord: "그날부터" },
};
// 기념일 종류 (입사일도 기념일의 한 종류)
const SUBS = {
  work:    { label: "입사일",   dayWord: "입사한지" },
  wedding: { label: "결혼",     dayWord: "결혼한지" },
  love:    { label: "연애",     dayWord: "사귄지" },
  open:    { label: "개업",     dayWord: "개업한지" },
  etc:     { label: "기타",     dayWord: "그날부터" },
};
// 예전 데이터 호환: work/etc 분류 → 기념일 + 종류
const normalize = (e) => {
  const x = { memos: {}, phone: "", visible: true, secret: false, afterDday: "extend", lunar: false, ...e }; // afterDday: "extend"(계속 세기) | "delete"(종료 후 삭제)
  if (x.cat === "work") { x.cat = "anniv"; x.sub = "work"; }
  if (x.cat === "etc") { x.cat = "anniv"; x.sub = x.sub || "etc"; }
  if (x.cat === "anniv" && !x.sub) x.sub = "etc";
  return x;
};
const catLabel = (e) => (e.cat === "anniv" ? `기념일·${SUBS[e.sub]?.label || "기타"}` : CATS[e.cat].label);
const dayWord = (e) => (e.cat === "anniv" ? SUBS[e.sub]?.dayWord || "그날부터" : CATS[e.cat].dayWord);
const KOR_DOL = ["", "첫", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열",
  "열한", "열두", "열세", "열네", "열다섯", "열여섯", "열일곱", "열여덟", "열아홉", "스무"];
const DAY_MILESTONES = [100, 200, 300, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 15000, 20000, 25000, 30000];
const STORAGE_KEY = "daycounter:entries";
const PIN_KEY = "daycounter:pin";
const HOL_KEY = "daycounter:holidays";
const HOLSRC_KEY = "daycounter:holsrc";
const GCAL_ID = "ko.south_korea#holiday@group.v.calendar.google.com"; // 구글 '대한민국의 휴일' 공개 캘린더

// 구글 공휴일 캘린더에서 연도별 공휴일 가져오기
// src: Google API 키(AIza…) 또는 GAS 웹앱 주소(https://script.google.com/…)
async function fetchGoogleHolidays(src, year) {
  let url;
  if (src.startsWith("http")) url = `${src}${src.includes("?") ? "&" : "?"}year=${year}`;
  else url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GCAL_ID)}/events?key=${encodeURIComponent(src)}&timeMin=${year}-01-01T00:00:00Z&timeMax=${year}-12-31T23:59:59Z&singleEvents=true&maxResults=100`;
  const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const out = {};
  if (j.items) { // Google API 형식: '공휴일'만 (제헌절·어버이날 같은 기념일은 제외)
    for (const it of j.items) { const d = it.start?.date; if (!d) continue; const desc = it.description || ""; if (desc && !desc.includes("공휴일")) continue; out[d] = it.summary; }
  } else { for (const [k, v] of Object.entries(j)) if (/^\d{4}-\d{2}-\d{2}$/.test(k)) out[k] = String(v); }
  if (Object.keys(out).length < 5) throw new Error(`${year}년 결과 없음`);
  return out;
}

// 웹 검색으로 한국 공휴일 갱신 (올해 ~ 2년 뒤). 내장 표 위에 덮어씀.
async function fetchHolidayYear(year) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: `${year}년 대한민국 공휴일 전체 목록을 웹에서 확인해 주세요. 설날·추석 연휴, 부처님오신날, 대체공휴일, 정부가 지정한 임시공휴일, 선거일까지 포함합니다. 최종 답변은 반드시 아래 형식의 JSON 객체 하나만, 다른 말·마크다운 없이 출력하세요.\n{"${year}-01-01":"신정","${year}-02-16":"설날 연휴"}` }],
    }),
  });
  const data = await res.json();
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("응답에서 JSON을 찾지 못함");
  const obj = JSON.parse(m[0]);
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k.startsWith(String(year))) out[k] = String(v);
  if (Object.keys(out).length < 5) throw new Error(`${year}년 결과가 너무 적음`);
  return out;
}

// ── 한국 공휴일 (2025~2028, 대체공휴일 포함) ─────────────
const HOLIDAYS = {
  "2025-01-01": "신정", "2025-01-27": "임시공휴일", "2025-01-28": "설날 연휴", "2025-01-29": "설날", "2025-01-30": "설날 연휴",
  "2025-03-01": "삼일절", "2025-03-03": "대체공휴일", "2025-05-05": "어린이날·부처님오신날", "2025-05-06": "대체공휴일",
  "2025-06-03": "대통령선거", "2025-06-06": "현충일", "2025-08-15": "광복절", "2025-10-03": "개천절",
  "2025-10-05": "추석 연휴", "2025-10-06": "추석", "2025-10-07": "추석 연휴", "2025-10-08": "대체공휴일", "2025-10-09": "한글날", "2025-12-25": "성탄절",

  "2026-01-01": "신정", "2026-02-16": "설날 연휴", "2026-02-17": "설날", "2026-02-18": "설날 연휴",
  "2026-03-01": "삼일절", "2026-03-02": "대체공휴일", "2026-05-05": "어린이날", "2026-05-24": "부처님오신날", "2026-05-25": "대체공휴일",
  "2026-06-03": "지방선거", "2026-06-06": "현충일", "2026-08-15": "광복절", "2026-08-17": "대체공휴일",
  "2026-09-24": "추석 연휴", "2026-09-25": "추석", "2026-09-26": "추석 연휴", "2026-10-03": "개천절", "2026-10-05": "대체공휴일",
  "2026-10-09": "한글날", "2026-12-25": "성탄절",

  "2027-01-01": "신정", "2027-02-06": "설날 연휴", "2027-02-07": "설날", "2027-02-08": "설날 연휴", "2027-02-09": "대체공휴일",
  "2027-03-01": "삼일절", "2027-05-05": "어린이날", "2027-05-13": "부처님오신날", "2027-06-06": "현충일", "2027-06-07": "대체공휴일",
  "2027-08-15": "광복절", "2027-08-16": "대체공휴일", "2027-09-14": "추석 연휴", "2027-09-15": "추석", "2027-09-16": "추석 연휴",
  "2027-10-03": "개천절", "2027-10-04": "대체공휴일", "2027-10-09": "한글날", "2027-10-11": "대체공휴일", "2027-12-25": "성탄절", "2027-12-27": "대체공휴일",

  "2028-01-01": "신정", "2028-01-25": "설날 연휴", "2028-01-26": "설날", "2028-01-27": "설날 연휴",
  "2028-03-01": "삼일절", "2028-05-02": "부처님오신날", "2028-05-05": "어린이날", "2028-06-06": "현충일", "2028-08-15": "광복절",
  "2028-10-02": "추석 연휴", "2028-10-03": "추석·개천절", "2028-10-04": "추석 연휴", "2028-10-05": "대체공휴일", "2028-10-09": "한글날", "2028-12-25": "성탄절",
};

const SEED = []; // 처음엔 빈 상태로 시작

// "예시로 둘러보기"를 누르면 넣는 샘플 (오늘 기준으로 날짜를 계산해 이벤트가 바로 보이게)
function makeExamples() {
  const t = new Date(), ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const ago = (y, dd = 0) => ymd(new Date(t.getFullYear() - y, t.getMonth(), t.getDate() + dd));
  const base = { memos: {}, phone: "", visible: true, secret: false, afterDday: "extend", lunar: false, example: true, note: "예시 항목이에요. 수정하거나 지워도 돼요." };
  return [
    { ...base, id: "ex1", name: "나",         cat: "me",   date: ago(38, 40) },
    { ...base, id: "ex2", name: "김첫째",     cat: "kid",  date: ago(9, 3) },
    { ...base, id: "ex3", name: "김둘째",     cat: "kid",  date: ago(0, -97) },
    { ...base, id: "ex4", name: "친구 생일",  cat: "friend", date: ago(37, 12) },
    { ...base, id: "ex5", name: "결혼기념일", cat: "anniv", sub: "wedding", date: ago(12, 25) },
    { ...base, id: "ex6", name: "여름휴가",   cat: "anniv", sub: "etc", date: ago(0, 20), afterDday: "delete", visible: true },
  ];
}

// ── 날짜 유틸 ─────────────────────────────────────────
const MS = 86400000;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
const diffDays = (a, b) => Math.round((b - a) / MS);
const pad = (n) => String(n).padStart(2, "0");
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = (d) => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}(${"일월화수목금토"[d.getDay()]})`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function monthsDays(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  let anchor = new Date(from.getFullYear(), from.getMonth() + months, from.getDate());
  if (anchor > to) { months--; anchor = new Date(from.getFullYear(), from.getMonth() + months, from.getDate()); }
  return { months, days: diffDays(anchor, to) };
}
// ── 음력 ──────────────────────────────────────────────
const _lc = new KoreanLunarCalendar();
function toLunar(d) { // 양력 Date → { year, month, day, intercalation(윤달) }
  if (!_lc.setSolarDate(d.getFullYear(), d.getMonth() + 1, d.getDate())) return null;
  return _lc.getLunarCalendar();
}
function lunarToSolar(y, m, d, leap = false) { // 음력 → 양력 Date (30일이 없는 달은 29일로)
  for (const [lp, dd] of [[leap, d], [false, d], [false, d - 1]]) {
    if (_lc.setLunarDate(y, m, dd, lp)) { const s = _lc.getSolarCalendar(); return new Date(s.year, s.month - 1, s.day); }
  }
  return null;
}
const lunarText = (L) => (L ? `${L.intercalation ? "윤" : ""}${L.month}.${L.day}` : "");
// n번째 생일·주년의 양력 날짜 (음력 항목이면 음력 기준으로 계산, 윤달생은 평달 기준)
function annivDate(entry, n) {
  const start = parse(entry.date);
  if (n === 0) return start;
  if (!entry.lunar) return new Date(start.getFullYear() + n, start.getMonth(), start.getDate());
  const L = toLunar(start);
  return L ? lunarToSolar(L.year + n, L.month, L.day) : null;
}

function yearLabel(cat, n) {
  if (cat === "kid") return n <= 20 ? `${KOR_DOL[n]}돌` : `${n}돌`;
  return `${n}${CATS[cat].unitYear}`;
}
function upcoming(entry, count = 6) {
  const start = parse(entry.date), t = today();
  const items = [];
  const elapsed = diffDays(start, t) + 1;
  for (let n = 1; n <= 100; n++) {
    const d = annivDate(entry, n);
    if (!d) break; // 음력 계산 범위(2050년) 밖
    if (d >= t) items.push({ label: yearLabel(entry.cat, n), date: d, left: diffDays(t, d) });
    if (items.length > count + 3) break;
  }
  for (const m of DAY_MILESTONES) if (m >= elapsed) items.push({ label: `${m}일`, date: addDays(start, m - 1), left: m - elapsed });
  return items.sort((a, b) => a.left - b.left).slice(0, count);
}
function stats(entry) {
  const start = parse(entry.date), t = today();
  if (start > t) return { future: true, dday: diffDays(t, start) };
  const elapsed = diffDays(start, t) + 1;
  const { months, days } = monthsDays(start, t);
  const years = Math.floor(months / 12); // 만 나이는 양력 기준
  // 직전/다음 생일·주년 (음력 항목은 음력 기준)
  let k = Math.max(0, years - 1);
  while (annivDate(entry, k + 1) && annivDate(entry, k + 1) <= t) k++;
  const prevYear = annivDate(entry, k), nextYear = annivDate(entry, k + 1) || prevYear;
  return { future: false, elapsed, months, days, weeks: Math.floor((elapsed - 1) / 7), wDays: (elapsed - 1) % 7, years,
    progress: nextYear > prevYear ? diffDays(prevYear, t) / diffDays(prevYear, nextYear) : 1, nextYearLabel: yearLabel(entry.cat, k + 1), nextYearLeft: diffDays(t, nextYear) };
}
// 특정 날짜에 해당하는 특별한 라벨 (돌·주년·100일 단위)
function specialLabel(entry, d) {
  const start = parse(entry.date);
  const n = diffDays(start, d) + 1;
  if (n < 1) return null;
  const y = d.getFullYear() - start.getFullYear();
  for (const k of [y - 1, y, y + 1]) {
    if (k < 1) continue;
    const a = annivDate(entry, k);
    if (a && diffDays(a, d) === 0) return yearLabel(entry.cat, k);
  }
  if (DAY_MILESTONES.includes(n)) return `${n}일`;
  return null;
}

// 문자·전화 연동 (sms: / tel: 스킴)
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const smsUrl = (phone, body) => `sms:${phone.replace(/[^0-9+]/g, "")}${isIOS() ? "&" : "?"}body=${encodeURIComponent(body)}`;
const telUrl = (phone) => `tel:${phone.replace(/[^0-9+]/g, "")}`;
const openUrl = (url) => { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); };
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } };

// 이번 주(오늘부터 7일) 큰 이벤트: 돌·주년·N일 마일스톤 + 메모
function weekEvents(entries) {
  const t = today();
  const out = [];
  for (const e of entries) {
    if (!e.visible) continue;
    for (const u of upcoming(e, 6)) if (u.left <= 6) out.push({ entry: e, label: u.label, date: u.date, left: u.left, kind: "big" });
    for (const [k, memo] of Object.entries(e.memos || {})) {
      const d = parse(k), left = diffDays(t, d);
      if (left >= 0 && left <= 6) out.push({ entry: e, label: memo, date: d, left, kind: "memo" });
    }
    if (parse(e.date) > t && diffDays(t, parse(e.date)) <= 6) out.push({ entry: e, label: "D-day", date: parse(e.date), left: diffDays(t, parse(e.date)), kind: "big" });
  }
  return out.sort((a, b) => a.left - b.left);
}
const suggestMessage = (entry, ev) => {
  const who = entry.name.length === 3 && entry.cat === "kid" ? entry.name.slice(1) : entry.name;
  if (!ev) return `${who}, 잘 지내지? 안부 전해요 🙂`;
  if (ev.kind === "memo") return `${who}, ${ev.left === 0 ? "오늘" : `${ev.left}일 뒤`} "${ev.label}" 잊지 않았지?`;
  return `${who}, ${ev.left === 0 ? "오늘" : fmt(ev.date)} ${ev.label} 축하해요 🎉`;
};

// 자물쇠 아이콘: 열리면 고리가 위로 들리고 오른쪽이 빠짐
function LockIcon({ open }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="11" rx="2.5" fill="currentColor" />
      <circle cx="12" cy="15.5" r="1.6" fill={open ? "#8B4FB6" : "#fff"} />
      <rect x="11.3" y="15.5" width="1.4" height="3" rx=".7" fill={open ? "#8B4FB6" : "#fff"} />
      {open
        ? <path d="M8 10.5V7a4 4 0 0 1 7.6-1.7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" transform="translate(0 -2.5)" />
        : <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
    </svg>
  );
}

const BG = { background: "#F4F6F3", color: "#1F2A26", fontSize: 16, WebkitTapHighlightColor: "transparent" };
const MobileCSS = () => (
  <style>{`
    button { min-height: 44px; touch-action: manipulation; }
    button:active { opacity: .65; }
    input, textarea, select { font-size: 16px !important; }
    input[type=date] { -webkit-appearance: none; appearance: none; display: block; width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; min-height: 52px; text-align: left; }
    .cell button { min-height: 0; }
    .safe-b { padding-bottom: calc(6rem + env(safe-area-inset-bottom)); }
  `}</style>
);

// ── 앱 ────────────────────────────────────────────────
function DayCounter() {
  const [entries, setEntries] = useState(null);
  const [view, setView] = useState({ type: "list" });
  const [filter, setFilter] = useState("all");
  const [saveErr, setSaveErr] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pin, setPin] = useState(null);          // 저장된 PIN (없으면 null)
  const [unlocked, setUnlocked] = useState(false); // 시크릿 잠금 해제 상태 (앱 재시작 시 다시 잠김)
  const [pinModal, setPinModal] = useState(null);  // { mode: "unlock" | "set", then }
  const [holidays, setHolidays] = useState({ data: HOLIDAYS, updated: null });
  const [holStatus, setHolStatus] = useState("");  // 갱신 진행 메시지
  const [holSrc, setHolSrc] = useState(() => localStorage.getItem(HOLSRC_KEY) || "");
  const [holSrcDraft, setHolSrcDraft] = useState(() => localStorage.getItem(HOLSRC_KEY) || "");

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(STORAGE_KEY, false);
        setEntries(r?.value ? JSON.parse(r.value).map(normalize) : SEED);
      } catch { setEntries(SEED); }
      try { const r = await window.storage.get(PIN_KEY, false); if (r?.value) setPin(r.value); } catch {}
      try { const r = await window.storage.get(HOL_KEY, false); if (r?.value) { const h = JSON.parse(r.value); setHolidays({ data: { ...HOLIDAYS, ...h.data }, updated: h.updated }); } } catch {}
    })();
  }, []);

  const pasteHolidays = async () => {
    const txt = prompt('공휴일 JSON을 붙여넣으세요.\n예) {"2029-01-01":"신정","2029-02-12":"설날 연휴"}');
    if (!txt) return;
    try {
      const m = txt.match(/\{[\s\S]*\}/); const obj = JSON.parse(m ? m[0] : txt);
      const add = {}; for (const [k, v] of Object.entries(obj)) if (/^\d{4}-\d{2}-\d{2}$/.test(k)) add[k] = String(v);
      if (!Object.keys(add).length) throw new Error("날짜가 없어요");
      const next = { data: { ...holidays.data, ...add }, updated: key(today()) };
      setHolidays(next); await window.storage.set(HOL_KEY, JSON.stringify(next), false);
      alert(`${Object.keys(add).length}개 공휴일을 추가했어요.`);
    } catch (e) { alert("형식을 읽지 못했어요: " + e.message); }
  };
  // 구글 공휴일 캘린더에서 올해~2년 뒤 자동 갱신
  const refreshHolidays = async (silent = false) => {
    if (!holSrc) { if (!silent) pasteHolidays(); return; }
    const y0 = today().getFullYear();
    let merged = { ...holidays.data }, ok = 0;
    for (const y of [y0, y0 + 1, y0 + 2]) {
      setHolStatus(`${y}년 공휴일 받는 중…`);
      try {
        const yr = await fetchGoogleHolidays(holSrc, y);
        merged = Object.fromEntries(Object.entries(merged).filter(([k]) => !k.startsWith(String(y))));
        merged = { ...merged, ...yr }; ok++;
      } catch (e) { if (!silent) alert(`${y}년 갱신 실패: ${e.message}`); }
    }
    if (ok) { const next = { data: merged, updated: key(today()) }; setHolidays(next); try { await window.storage.set(HOL_KEY, JSON.stringify(next), false); } catch {} }
    setHolStatus("");
  };
  // 앱을 열 때 30일 넘었으면 조용히 자동 갱신
  useEffect(() => {
    if (!entries || !holSrc) return;
    const stale = !holidays.updated || diffDays(parse(holidays.updated), today()) >= 30;
    if (stale) refreshHolidays(true);
  }, [entries, holSrc]); // eslint-disable-line

  const savePin = async (p) => { setPin(p); try { await window.storage.set(PIN_KEY, p, false); } catch {} };
  const toggleLock = () => {
    if (unlocked) { setUnlocked(false); setView({ type: "list" }); return; }
    if (!pin) setPinModal({ mode: "set", then: () => setUnlocked(true) });
    else setPinModal({ mode: "unlock", then: () => setUnlocked(true) });
  };
  // 잠긴 상태에서는 시크릿 항목이 아예 없는 것처럼 동작
  const visibleEntries = useMemo(() => (entries ? entries.filter((e) => unlocked || !e.secret) : []), [entries, unlocked]);

  const persist = async (list) => {
    setEntries(list);
    try { await window.storage.set(STORAGE_KEY, JSON.stringify(list), false); setSaveErr(false); }
    catch { setSaveErr(true); }
  };
  const updateEntry = (e) => persist(entries.map((x) => (x.id === e.id ? e : x)));

  const shown = useMemo(() => {
    const list = filter === "all" ? visibleEntries : visibleEntries.filter((e) => e.cat === filter);
    return [...list].sort((a, b) => parse(a.date) - parse(b.date));
  }, [visibleEntries, filter]);

  const soon = useMemo(() => {
    return visibleEntries.flatMap((e) => upcoming(e, 3).map((u) => ({ ...u, entry: e })))
      .filter((u) => u.left <= 60).sort((a, b) => a.left - b.left).slice(0, 4);
  }, [visibleEntries]);

  const week = useMemo(() => weekEvents(visibleEntries), [visibleEntries]);
  // 지나간 D-day 중 "종료 후 삭제"로 설정된 항목 → 삭제할지 물어봄
  const finished = useMemo(() => visibleEntries.filter((e) => e.afterDday === "delete" && parse(e.date) < today()), [visibleEntries]);
  const font = { fontFamily: "'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif" };
  if (!entries) return <div style={font} className="min-h-screen flex items-center justify-center text-gray-400">불러오는 중…</div>;

  const pinModalEl = pinModal && <PinModal font={font} mode={pinModal.mode} pin={pin} onClose={() => setPinModal(null)}
    onOk={(p) => { if (pinModal.mode === "set") savePin(p); setPinModal(null); pinModal.then?.(); }} />;

  if (view.type === "form") return <><Form font={font} initial={view.entry} hasPin={!!pin} requestPin={(then) => setPinModal({ mode: "set", then })} onCancel={() => setView(view.entry ? { type: "detail", id: view.entry.id } : { type: "list" })}
    onSave={(e) => { persist(view.entry ? entries.map((x) => (x.id === e.id ? e : x)) : [...entries, e]); if (e.secret) setUnlocked(true); setView({ type: "detail", id: e.id }); }} />{pinModalEl}</>;

  if (view.type === "detail") {
    const entry = visibleEntries.find((e) => e.id === view.id);
    if (!entry) { setView({ type: "list" }); return null; }
    return <Detail font={font} entry={entry} event={view.event} holidays={holidays} holStatus={holStatus} onRefreshHolidays={refreshHolidays} onBack={() => setView({ type: "list" })} onEdit={() => setView({ type: "form", entry })} onUpdate={updateEntry}
      onDelete={() => { if (confirm(`${entry.name} 항목을 삭제할까요?`)) { persist(entries.filter((e) => e.id !== entry.id)); setView({ type: "list" }); } }} />;
  }

  return (
    <div style={{ ...font, ...BG }} className="min-h-screen safe-b">
      <MobileCSS />
      <header className="px-5 pt-6 pb-3 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Easyday</h1>
        <span className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{fmt(today())}</span>
          <button onClick={toggleLock} aria-label={unlocked ? "시크릿 열림 - 눌러서 잠그기" : "시크릿 잠김 - 눌러서 열기"}
            className="h-11 flex items-center justify-center gap-1 rounded-full shadow-sm transition-all"
            style={unlocked ? { background: "#8B4FB6", color: "#fff", padding: "0 14px 0 10px" } : { background: "#fff", color: "#1F2A26", width: 44 }}>
            <LockIcon open={unlocked} />
            {unlocked && <span className="text-sm font-semibold">열림</span>}
          </button>
          <button onClick={() => setMenu(!menu)} aria-label="설정" className="text-2xl leading-none w-11 h-11 flex items-center justify-center rounded-full bg-white shadow-sm">⋯</button>
        </span>
      </header>
      {menu && (
        <div className="mx-5 mb-3 bg-white rounded-2xl p-3 shadow-sm flex flex-col gap-1">
          <button onClick={() => { exportBackup(); setMenu(false); }} className="text-left px-3 rounded-xl">💾 백업 파일 내보내기</button>
          <label className="px-3 rounded-xl flex items-center min-h-[44px] cursor-pointer">📂 백업 파일 가져오기
            <input type="file" accept="application/json,.json" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { await importBackup(f); location.reload(); } catch (err) { alert("가져오기 실패: " + err.message); } }} />
          </label>
          <p className="px-3 py-2 text-xs text-gray-400">데이터는 이 폰에만 저장돼요. 폰을 바꾸기 전에 백업을 받아두세요.</p>
          <div className="border-t border-gray-100 pt-3 px-3 pb-2">
            <p className="text-base font-medium">📅 공휴일 자동 갱신</p>
            <p className="text-xs text-gray-400 mb-2">구글 '대한민국의 휴일' 캘린더에서 3년치를 받아와요. 아래에 Google API 키 또는 GAS 웹앱 주소를 넣으세요. 비워두면 수동 붙여넣기.</p>
            <input value={holSrcDraft} onChange={(e) => setHolSrcDraft(e.target.value)} placeholder="AIza… 또는 https://script.google.com/macros/s/…/exec"
              className="w-full bg-gray-50 rounded-xl px-3 py-3 border border-gray-200 focus:outline-none focus:border-gray-900" />
            <div className="flex gap-2 mt-2">
              <button onClick={() => { const v = holSrcDraft.trim(); setHolSrc(v); localStorage.setItem(HOLSRC_KEY, v); setMenu(false); if (v) setTimeout(() => refreshHolidays(false), 0); }}
                className="flex-1 rounded-xl text-white font-semibold" style={{ background: "#1F2A26" }}>저장하고 지금 갱신</button>
            </div>
            <p className="text-xs text-gray-400 mt-2">{holidays.updated ? `마지막 갱신 ${holidays.updated}` : "아직 갱신 안 함 (내장 2025~2028 사용)"}{holSrc ? " · 30일마다 자동" : ""}</p>
          </div>
        </div>
      )}
      {unlocked && <p className="mx-5 mb-2 text-xs" style={{ color: "#8B4FB6" }}>시크릿 항목이 보이는 중이에요. 🔓를 누르면 다시 숨겨요.</p>}
      {pinModalEl}
      {saveErr && <p className="mx-5 mb-2 text-xs text-red-600">저장하지 못했어요. 잠시 후 다시 시도해 주세요.</p>}
      {entries.some((e) => e.example) && (
        <div className="mx-5 mb-3 flex items-center justify-between rounded-2xl px-4 py-2 bg-white border border-dashed border-gray-300">
          <span className="text-sm text-gray-500">예시 항목으로 둘러보는 중이에요</span>
          <button onClick={() => persist(entries.filter((e) => !e.example))} className="text-sm font-semibold px-2" style={{ color: "#C2410C" }}>예시 모두 지우기</button>
        </div>
      )}

      {finished.length > 0 && (
        <section className="mx-5 mb-3 rounded-2xl px-4 py-3 shadow-sm border" style={{ background: "#FFF7ED", borderColor: "#FDBA74" }}>
          <p className="text-xs mb-1" style={{ color: "#C2410C" }}>D-day가 지났어요</p>
          {finished.map((e) => (
            <div key={e.id} className="flex items-center justify-between py-1.5">
              <span className="min-w-0"><span className="font-semibold">{e.name}</span> <span className="text-xs text-gray-500">{e.date.replaceAll("-", ".")} · {diffDays(parse(e.date), today())}일 지남</span></span>
              <span className="flex gap-2 shrink-0 ml-2">
                <button onClick={() => updateEntry({ ...e, afterDday: "extend" })} className="text-sm px-3 rounded-xl border border-gray-300 text-gray-600 bg-white">계속 세기</button>
                <button onClick={() => persist(entries.filter((x) => x.id !== e.id))} className="text-sm px-3 rounded-xl text-white" style={{ background: "#C2410C" }}>삭제</button>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="mx-5 mb-3 rounded-2xl px-4 py-3 text-white shadow-sm" style={{ background: "#1F2A26" }}>
        <p className="text-xs opacity-70 mb-2">이번 주 큰 이벤트</p>
        {week.length === 0 && <p className="text-sm opacity-80">이번 주에는 큰 이벤트가 없어요.</p>}
        {week.map((u, i) => (
          <button key={i} onClick={() => setView({ type: "detail", id: u.entry.id, event: u })} className="w-full flex items-center justify-between py-3 text-left border-t border-white/10 first:border-0">
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CATS[u.entry.cat].color }} />
                <span className="font-semibold">{u.entry.name}</span>
                <span className="text-sm opacity-80 truncate">{u.label}</span>
              </span>
              <span className="block text-xs opacity-60 pl-4">{fmt(u.date)}{u.entry.phone ? " · 문자 가능" : ""}</span>
            </span>
            <span className="text-base font-bold shrink-0 ml-2 px-2 py-1 rounded-lg bg-white/15">{u.left === 0 ? "오늘" : `D-${u.left}`}</span>
          </button>
        ))}
      </section>

      {soon.length > 0 && (
        <section className="mx-5 mb-4 bg-white rounded-2xl px-4 py-3 shadow-sm">
          <p className="text-xs text-gray-500 mb-2">다가오는 날 (60일 이내)</p>
          {soon.map((u, i) => (
            <button key={i} onClick={() => setView({ type: "detail", id: u.entry.id })} className="w-full flex items-center justify-between py-2.5 text-left">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: CATS[u.entry.cat].color }} />
                <span className="font-medium">{u.entry.name}</span>
                <span className="text-gray-500 text-sm">{u.label}</span>
              </span>
              <span className="text-sm font-semibold" style={{ color: CATS[u.entry.cat].color }}>{u.left === 0 ? "오늘" : `D-${u.left}`}</span>
            </button>
          ))}
        </section>
      )}

      <div className="flex gap-2 px-5 overflow-x-auto pb-3">
        {[["all", "전체"], ...Object.entries(CATS).map(([k, v]) => [k, v.label])].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className="shrink-0 px-4 py-2 rounded-full text-base border"
            style={filter === k
              ? { background: k === "all" ? "#1F2A26" : CATS[k].color, borderColor: k === "all" ? "#1F2A26" : CATS[k].color, color: "#fff" }
              : { background: "#fff", borderColor: "#E5E7EB", color: "#555" }}>{l}</button>
        ))}
      </div>

      <ul className="px-5 space-y-2">
        {entries.length === 0 && (
          <li className="bg-white rounded-2xl p-5 shadow-sm">
            <p className="text-xl font-bold mb-1">Easyday에 오신 걸 환영해요 👋</p>
            <p className="text-base text-gray-600 mb-4">아이·나·친구 생일과 기념일, D-day를 광고 없이 챙기는 앱이에요.</p>
            <ul className="space-y-2 text-base text-gray-700 mb-5">
              <li>➕ 오른쪽 아래 <b>+</b> 로 사람이나 기념일을 추가해요</li>
              <li>📅 항목을 누르고 옆으로 밀면 <b>달력</b>, 날짜를 누르면 <b>메모</b></li>
              <li>🌙 날짜는 <b>양력/음력</b> 중에 골라 입력할 수 있어요</li>
              <li>💬 전화번호를 넣으면 축하 <b>문자</b>를 바로 보내요</li>
              <li>🔒 남에게 안 보이게 하려면 <b>시크릿</b>으로 저장해요</li>
              <li>💾 데이터는 이 폰에만 저장돼요. <b>⋯ → 백업</b>을 가끔 받아두세요</li>
            </ul>
            <div className="flex gap-2">
              <button onClick={() => persist(makeExamples())} className="flex-1 rounded-xl border border-gray-300 text-base font-medium">예시로 둘러보기</button>
              <button onClick={() => setView({ type: "form" })} className="flex-1 rounded-xl text-white text-base font-semibold" style={{ background: "#1F2A26" }}>첫 항목 추가</button>
            </div>
          </li>
        )}
        {entries.length > 0 && shown.length === 0 && <li className="text-center text-gray-400 py-12 text-base">이 분류에는 아직 항목이 없어요.</li>}
        {shown.map((e) => {
          const s = stats(e), c = CATS[e.cat];
          return (
            <li key={e.id}>
              <button onClick={() => setView({ type: "detail", id: e.id })} className="w-full bg-white rounded-2xl px-4 py-4 text-left shadow-sm flex items-center gap-3">
                <span className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-xl shrink-0" style={{ background: c.color }}>{e.name[0]}</span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline justify-between">
                    <span className="font-semibold text-lg truncate">{e.name}</span>
                    <span className="text-xs text-gray-400 ml-2 shrink-0">{e.secret && "🕶 "}{!e.visible && "🔒 "}{catLabel(e)} · {e.lunar ? `음 ${lunarText(toLunar(parse(e.date))).replace(".", "/")}` : e.date.slice(5).replace("-", "/")}</span>
                  </span>
                  {s.future
                    ? <span className="text-base font-bold" style={{ color: "#2563EB" }}>D-{s.dday}</span>
                    : <span className="text-base"><b style={{ color: c.color }}>{s.elapsed.toLocaleString()}일째</b> <span className="text-gray-500">· {s.months}개월 {s.days}일</span></span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <button onClick={() => setView({ type: "form" })} aria-label="항목 추가"
        style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
        className="fixed right-5 w-16 h-16 rounded-full bg-gray-900 text-white text-4xl leading-none shadow-lg flex items-center justify-center">+</button>
    </div>
  );
}

// ── 상세 (정보 ⇄ 달력 스와이프) ───────────────────────
function Detail({ font, entry, event, holidays, holStatus, onRefreshHolidays, onBack, onEdit, onDelete, onUpdate }) {
  const [page, setPage] = useState(0); // 0 정보, 1 달력
  const touch = useRef(null);
  const c = CATS[entry.cat];
  const onTouchStart = (e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e) => {
    if (!touch.current) return;
    const dx = e.changedTouches[0].clientX - touch.current.x, dy = e.changedTouches[0].clientY - touch.current.y;
    touch.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) setPage(dx < 0 ? 1 : 0);
  };

  return (
    <div style={{ ...font, ...BG }} className="min-h-screen pb-10 overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <MobileCSS />
      <header className="px-3 pt-3 pb-1 flex items-center justify-between">
        <button onClick={onBack} className="text-gray-700 text-base px-2">‹ 목록</button>
        <div className="flex gap-1 text-base">
          <button onClick={onEdit} className="text-gray-700 px-3">수정</button>
          <button onClick={onDelete} className="text-red-500 px-3">삭제</button>
        </div>
      </header>

      <div className="px-5 flex items-baseline justify-between">
        <h2 className="text-3xl font-bold">{entry.name}</h2>
        <span className="text-sm text-gray-500 text-right">{catLabel(entry)} · {entry.date.replaceAll("-", ".")}{entry.lunar && <span className="block">음력 {toLunar(parse(entry.date))?.year}.{lunarText(toLunar(parse(entry.date)))}</span>}</span>
      </div>

      <div className="px-5 mt-3 flex gap-5 border-b border-gray-200">
        {["정보", "달력"].map((l, i) => (
          <button key={l} onClick={() => setPage(i)} className="px-2 text-lg font-semibold relative" style={{ color: page === i ? c.color : "#9CA3AF" }}>
            {l}{page === i && <span className="absolute left-0 right-0 -bottom-px h-0.5" style={{ background: c.color }} />}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-400 self-center">← 밀어서 전환</span>
      </div>

      <div className="flex transition-transform duration-300" style={{ width: "200%", transform: `translateX(${page * -50}%)` }}>
        <div className="w-1/2 shrink-0"><Contact entry={entry} c={c} event={event} /><Info entry={entry} c={c} /></div>
        <div className="w-1/2 shrink-0"><CalendarPage entry={entry} c={c} onUpdate={onUpdate} holidays={holidays} holStatus={holStatus} onRefreshHolidays={onRefreshHolidays} /></div>
      </div>
    </div>
  );
}

function Contact({ entry, c, event }) {
  const ev = event || (parse(entry.date) <= today() ? { ...upcoming(entry, 1)[0], kind: "big" } : null);
  const [msg, setMsg] = useState(suggestMessage(entry, ev && ev.label ? ev : null));
  const [copied, setCopied] = useState(false);
  if (!entry.phone) return (
    <p className="mx-5 mt-4 text-xs text-gray-400">전화번호를 등록하면 여기서 바로 문자·전화를 보낼 수 있어요. (수정 → 전화번호)</p>
  );
  return (
    <div className="mx-5 mt-4 bg-white rounded-2xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-base text-gray-600">{entry.phone}</span>
        <button onClick={() => openUrl(telUrl(entry.phone))} className="text-base font-semibold px-3 rounded-xl border" style={{ color: c.color, borderColor: c.color }}>📞 전화</button>
      </div>
      {ev && ev.label && <p className="text-xs text-gray-400 mb-1">{ev.left === 0 ? "오늘" : `D-${ev.left}`} · {ev.label}</p>}
      <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-gray-900" />
      <div className="flex gap-2 mt-2">
        <button onClick={() => openUrl(smsUrl(entry.phone, msg))} className="flex-1 py-3 rounded-xl text-white text-base font-semibold" style={{ background: c.color }}>💬 문자 보내기</button>
        <button onClick={async () => { setCopied(await copyText(msg)); setTimeout(() => setCopied(false), 1500); }} className="px-4 py-3 rounded-xl border border-gray-200 text-base text-gray-600">{copied ? "복사됨" : "복사"}</button>
      </div>
    </div>
  );
}

function Info({ entry, c }) {
  const s = stats(entry);
  const list = s.future ? [] : upcoming(entry, 8);
  return (
    <div className="px-5 pt-4">
      {entry.note && <p className="text-sm text-gray-500 mb-2">{entry.note}</p>}
      {s.future ? (
        <div className="mt-6 text-center">
          <p className="text-6xl font-bold" style={{ color: c.color }}>D-{s.dday}</p>
          <p className="mt-2 text-gray-500">{fmt(parse(entry.date))}</p>
        </div>
      ) : (
        <>
          <p className="text-gray-600">{dayWord(entry)}</p>
          <p className="text-6xl font-bold leading-tight" style={{ color: c.color }}>{s.elapsed.toLocaleString()}<span className="text-3xl text-gray-700 font-medium ml-1">일째</span></p>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[[`${s.weeks}주 ${s.wDays}일`, "주"], [`${s.months}개월 ${s.days}일`, "개월"], [`만 ${s.years}세`, "나이"]].map(([v, l]) => (
              <div key={l} className="bg-white rounded-xl py-3"><p className="font-semibold text-base">{v}</p><p className="text-sm text-gray-400 mt-0.5">{l}</p></div>
            ))}
          </div>
          <div className="mt-6">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-500">{s.nextYearLeft}일 남음</span>
              <span className="font-medium" style={{ color: c.color }}>{s.nextYearLabel}</span>
            </div>
            <div className="h-2 rounded-full bg-gray-200 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.round(s.progress * 100)}%`, background: c.color }} /></div>
            <p className="text-right text-xs text-gray-400 mt-1">{Math.round(s.progress * 100)}%</p>
          </div>
        </>
      )}
      {list.length > 0 && (
        <section className="mt-8">
          <h3 className="font-semibold mb-2">다가오는 기념일</h3>
          <ul className="bg-white rounded-2xl divide-y divide-gray-100">
            {list.map((u, i) => (
              <li key={i} className="flex items-center justify-between px-4 py-3.5">
                <span className="font-medium text-base">{u.label}</span>
                <span className="text-right">
                  <span className="block text-sm text-gray-500">{fmt(u.date)}</span>
                  <span className="text-sm font-semibold" style={{ color: c.color }}>{u.left === 0 ? "오늘" : `${u.left}일 남음`}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── 달력 + 메모 ───────────────────────────────────────
function CalendarPage({ entry, c, onUpdate, holidays, holStatus, onRefreshHolidays }) {
  const HOL = holidays.data;
  const t = today();
  const [ym, setYm] = useState({ y: t.getFullYear(), m: t.getMonth() });
  const [sel, setSel] = useState(null); // "YYYY-MM-DD"
  const [text, setText] = useState("");
  const start = parse(entry.date);
  const memos = entry.memos || {};

  const first = new Date(ym.y, ym.m, 1);
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(first, i - first.getDay()));
  const monthMemos = Object.keys(memos).filter((k) => k.startsWith(`${ym.y}-${pad(ym.m + 1)}`)).sort();

  const openDay = (d) => { const k = key(d); setSel(k); setText(memos[k] || ""); };
  const saveMemo = () => {
    const next = { ...memos };
    if (text.trim()) next[sel] = text.trim(); else delete next[sel];
    onUpdate({ ...entry, memos: next });
    setSel(null);
  };

  return (
    <div className="px-4 pt-4">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setYm(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))} className="w-12 h-12 text-gray-600 text-3xl">‹</button>
        <button onClick={() => setYm({ y: t.getFullYear(), m: t.getMonth() })} className="font-bold text-xl px-4">{ym.y}. {ym.m + 1}</button>
        <button onClick={() => setYm(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))} className="w-12 h-12 text-gray-600 text-3xl">›</button>
      </div>

      <div className="bg-white rounded-2xl overflow-hidden shadow-sm">
        <div className="grid grid-cols-7 text-center text-sm text-gray-400 py-1.5 border-b border-gray-100">
          {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => <span key={d} style={{ color: i === 0 ? "#E5567A" : i === 6 ? "#2A9D8F" : undefined }}>{d}</span>)}
        </div>
        <div className="grid grid-cols-7 cell">
          {cells.map((d, i) => {
            const inMonth = d.getMonth() === ym.m, k = key(d), n = diffDays(start, d) + 1;
            const isToday = diffDays(t, d) === 0, sp = specialLabel(entry, d), hasMemo = !!memos[k], hol = HOL[k];
            const L = toLunar(d), showLunar = L && (L.day === 1 || L.day === 15);
            return (
              <button key={i} onClick={() => openDay(d)} className="h-20 border-b border-r border-gray-100 flex flex-col items-start p-1 text-left overflow-hidden"
                style={{ opacity: inMonth ? 1 : 0.3, background: sel === k ? "#F4F6F3" : undefined }}>
                <span className="flex items-center w-full gap-0.5">
                  <span className="text-sm font-medium w-6 h-6 flex items-center justify-center rounded-full shrink-0"
                    style={isToday ? { background: c.color, color: "#fff" } : { color: hol || d.getDay() === 0 ? "#E5567A" : d.getDay() === 6 ? "#2A9D8F" : undefined }}>{d.getDate()}</span>
                  {showLunar && <span className="text-[9px] leading-none text-gray-400 whitespace-nowrap">{lunarText(L)}</span>}
                </span>
                {n >= 1 && (n % 10 === 0 || isToday) && <span className="text-[11px] leading-tight whitespace-nowrap font-semibold" style={{ color: c.color }}>{n.toLocaleString()}</span>}
                {n < 1 && ((1 - n) % 10 === 0 || 1 - n < 10 || isToday) && <span className="text-[11px] leading-tight whitespace-nowrap font-semibold" style={{ color: "#2563EB" }}>D-{1 - n}</span>}
                {n === 1 && <span className="text-[11px] leading-tight font-bold truncate w-full" style={{ color: "#2563EB" }}>D-day</span>}
                {sp && <span className="text-[11px] leading-tight font-bold truncate w-full" style={{ color: c.color }}>{sp}</span>}
                {hol && <span className="text-[10px] leading-tight truncate w-full" style={{ color: "#E5567A" }}>{hol}</span>}
                {hasMemo && <span className="text-[11px] leading-tight text-gray-700 truncate w-full rounded px-0.5" style={{ background: "#F1F3F0" }}>{memos[k]}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between mt-2 px-1 text-sm text-gray-400">
        <span>{holStatus || (holidays.updated ? `공휴일 갱신: ${holidays.updated}` : "공휴일: 내장 데이터(2025~2028)")}</span>
        <button onClick={() => onRefreshHolidays(false)} disabled={!!holStatus} className="font-medium" style={{ color: holStatus ? "#9CA3AF" : "#2563EB" }}>{holStatus ? "갱신 중…" : "↻ 공휴일 갱신"}</button>
      </div>

      {sel && (
        <div className="mt-3 bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-base font-semibold mb-2">{fmt(parse(sel))} <span className="font-normal text-gray-400">· {diffDays(start, parse(sel)) + 1 >= 1 ? `${diffDays(start, parse(sel)) + 1}일째` : "시작 전"}{HOL[sel] && <span style={{ color: "#E5567A" }}> · {HOL[sel]}</span>}<span className="block text-sm">음력 {(() => { const L = toLunar(parse(sel)); return L ? `${L.intercalation ? "윤" : ""}${L.month}월 ${L.day}일` : "-"; })()}</span></span></p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus placeholder="이 날의 메모 (예: 예방접종, 학예회, 첫 걸음마)"
            className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base focus:outline-none focus:border-gray-900" />
          <div className="flex justify-end gap-2 mt-2 text-base">
            <button onClick={() => setSel(null)} className="text-gray-500 px-3">닫기</button>
            {memos[sel] && <button onClick={() => { setText(""); onUpdate({ ...entry, memos: Object.fromEntries(Object.entries(memos).filter(([k]) => k !== sel)) }); setSel(null); }} className="text-red-500 px-3">삭제</button>}
            <button onClick={saveMemo} className="font-semibold text-white px-5 rounded-xl" style={{ background: c.color }}>저장</button>
          </div>
        </div>
      )}

      {monthMemos.length > 0 && (
        <section className="mt-4">
          <h3 className="font-semibold mb-2 text-sm">이번 달 메모</h3>
          <ul className="bg-white rounded-2xl divide-y divide-gray-100">
            {monthMemos.map((k) => (
              <li key={k}><button onClick={() => openDay(parse(k))} className="w-full flex gap-3 px-4 py-3 text-left text-base">
                <span className="text-gray-400 shrink-0">{k.slice(8)}일</span><span className="truncate">{memos[k]}</span>
              </button></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Form({ font, initial, hasPin, requestPin, onCancel, onSave }) {
  const [name, setName] = useState(initial?.name || "");
  const [date, setDate] = useState(initial?.date || "");
  const [cat, setCat] = useState(initial?.cat || "kid");
  const [lunar, setLunar] = useState(initial?.lunar ?? false);
  const initL = initial?.date ? toLunar(parse(initial.date)) : null;
  const [ly, setLy] = useState(initL ? String(initL.year) : "");
  const [lm, setLm] = useState(initL ? initL.month : 1);
  const [ld, setLd] = useState(initL ? initL.day : 1);
  const [lleap, setLleap] = useState(initL ? initL.intercalation : false);
  const [lunarErr, setLunarErr] = useState("");
  // 음력 입력 → 양력 날짜로 변환해 저장
  const applyLunar = (y, m, d, leap) => {
    if (!/^\d{4}$/.test(String(y))) { setLunarErr(""); return; }
    const sd = _lc.setLunarDate(Number(y), Number(m), Number(d), leap) ? _lc.getSolarCalendar() : null;
    if (!sd) { setLunarErr(leap ? "그 해에는 해당 윤달이 없어요." : "없는 날짜예요 (작은달은 29일까지)."); return; }
    setLunarErr(""); setDate(`${sd.year}-${pad(sd.month)}-${pad(sd.day)}`);
  };
  const toggleLunar = () => {
    if (!lunar && date) { const L = toLunar(parse(date)); if (L) { setLy(String(L.year)); setLm(L.month); setLd(L.day); setLleap(L.intercalation); } }
    setLunar(!lunar);
  };
  const [sub, setSub] = useState(initial?.sub || "work");
  const [note, setNote] = useState(initial?.example ? "" : initial?.note || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [visible, setVisible] = useState(initial?.visible ?? true);
  const [secret, setSecret] = useState(initial?.secret ?? false);
  const [afterDday, setAfterDday] = useState(initial?.afterDday || "extend");
  const isFuture = /^\d{4}-\d{2}-\d{2}$/.test(date) && parse(date) > today();
  const valid = name.trim() && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const input = "w-full bg-white rounded-xl px-4 py-3.5 border border-gray-200 focus:outline-none focus:border-gray-900";
  return (
    <div style={{ ...font, ...BG }} className="min-h-screen px-5 pt-3 pb-16">
      <MobileCSS />
      <header className="flex items-center justify-between mb-5">
        <button onClick={onCancel} className="text-gray-600 text-base px-2">취소</button>
        <h2 className="font-semibold text-lg">{initial ? "수정" : "새 항목"}</h2>
        <button disabled={!valid} onClick={() => onSave({ id: initial?.id || String(Date.now()), name: name.trim(), date, cat, sub: cat === "anniv" ? sub : undefined, note: note.trim(), phone: phone.trim(), visible: secret ? false : visible, secret, afterDday, lunar, example: false, memos: initial?.memos || {} })}
          className={`text-base font-bold px-3 ${valid ? "text-gray-900" : "text-gray-300"}`}>저장</button>
      </header>
      <label className="block text-base text-gray-500 mb-1">이름</label>
      <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 김첫째, 어머니 생신, 결혼기념일" />
      <div className="flex items-center justify-between mt-4 mb-1">
        <label className="text-base text-gray-500">날짜</label>
        <div className="flex rounded-full bg-white border border-gray-200 p-0.5">
          {[[false, "양력"], [true, "음력"]].map(([v, l]) => (
            <button key={l} onClick={() => lunar !== v && toggleLunar()} className="px-4 rounded-full text-sm" style={{ minHeight: 36, ...(lunar === v ? { background: "#1F2A26", color: "#fff" } : { color: "#555" }) }}>{l}</button>
          ))}
        </div>
      </div>
      {!lunar ? (
        <div className="relative">
          <input type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
          {!date && <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">탭해서 날짜 선택</span>}
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input inputMode="numeric" maxLength={4} className={input + " flex-[1.4]"} placeholder="년(예: 1985)" value={ly}
              onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); setLy(v); applyLunar(v, lm, ld, lleap); }} />
            <select className={input + " flex-1"} value={lm} onChange={(e) => { setLm(+e.target.value); applyLunar(ly, +e.target.value, ld, lleap); }}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}월</option>)}
            </select>
            <select className={input + " flex-1"} value={ld} onChange={(e) => { setLd(+e.target.value); applyLunar(ly, lm, +e.target.value, lleap); }}>
              {Array.from({ length: 30 }, (_, i) => <option key={i} value={i + 1}>{i + 1}일</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 mt-2 text-sm text-gray-600 min-h-[36px]">
            <input type="checkbox" checked={lleap} onChange={(e) => { setLleap(e.target.checked); applyLunar(ly, lm, ld, e.target.checked); }} className="w-5 h-5" /> 윤달
          </label>
          {lunarErr ? <p className="text-sm text-red-500">{lunarErr}</p>
            : date && <p className="text-sm text-gray-500">양력 {date.replaceAll("-", ".")} · 생일·주년은 매년 음력 날짜로 챙겨요</p>}
        </>
      )}
      <label className="block text-base text-gray-500 mt-4 mb-2">분류</label>
      <div className="flex flex-wrap gap-2">
        {Object.entries(CATS).map(([k, v]) => (
          <button key={k} onClick={() => setCat(k)} className="px-4 py-2 rounded-full text-base border"
            style={cat === k ? { background: v.color, borderColor: v.color, color: "#fff" } : { background: "#fff", borderColor: "#E5E7EB", color: "#555" }}>{v.label}</button>
        ))}
      </div>
      {cat === "anniv" && (
        <>
          <label className="block text-base text-gray-500 mt-4 mb-2">기념일 종류</label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(SUBS).map(([k, v]) => (
              <button key={k} onClick={() => setSub(k)} className="px-4 py-2 rounded-full text-base border"
                style={sub === k ? { background: CATS.anniv.color, borderColor: CATS.anniv.color, color: "#fff" } : { background: "#fff", borderColor: "#E5E7EB", color: "#555" }}>{v.label}</button>
            ))}
          </div>
        </>
      )}
      <label className="block text-base text-gray-500 mt-4 mb-1">메모 (선택)</label>
      <input className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 우리 막내" />
      {isFuture && (
        <>
          <label className="block text-base text-gray-500 mt-4 mb-2">D-day가 지나면</label>
          <div className="flex gap-2">
            {[["extend", "연장 · 계속 세기", "당일부터 N일째로 이어서 셉니다"], ["delete", "종료 후 삭제", "지나면 첫 화면에서 삭제 여부를 물어요"]].map(([k, l, d]) => (
              <button key={k} onClick={() => setAfterDday(k)} className="flex-1 text-left rounded-xl px-3 py-2 border"
                style={afterDday === k ? { borderColor: "#1F2A26", background: "#1F2A26", color: "#fff" } : { borderColor: "#E5E7EB", background: "#fff", color: "#555" }}>
                <span className="block text-base font-medium">{l}</span><span className="block text-xs opacity-70">{d}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <label className="block text-base text-gray-500 mt-4 mb-1">전화번호 (선택)</label>
      <input type="tel" className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-0000-0000" />
      <button onClick={() => setVisible(!visible)} className="mt-5 w-full flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-200">
        <span className="text-left"><span className="block text-base font-medium">첫 화면에 공개</span><span className="block text-sm text-gray-400">이번 주 큰 이벤트에 이 항목을 보여줘요</span></span>
        <span className="w-14 h-8 rounded-full relative transition-colors shrink-0" style={{ background: visible ? "#1F2A26" : "#D1D5DB" }}>
          <span className="absolute top-1 w-6 h-6 rounded-full bg-white transition-all" style={{ left: visible ? "1.75rem" : "0.25rem" }} />
        </span>
      </button>
      <button onClick={() => { if (!secret && !hasPin) requestPin(() => setSecret(true)); else setSecret(!secret); }}
        className="mt-3 w-full flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-200">
        <span className="text-left"><span className="block text-base font-medium">🕶 시크릿</span><span className="block text-sm text-gray-400">잠금(PIN)을 풀기 전까지는 어디에도 보이지 않아요</span></span>
        <span className="w-14 h-8 rounded-full relative transition-colors shrink-0" style={{ background: secret ? "#8B4FB6" : "#D1D5DB" }}>
          <span className="absolute top-1 w-6 h-6 rounded-full bg-white transition-all" style={{ left: secret ? "1.75rem" : "0.25rem" }} />
        </span>
      </button>
      <p className="text-sm text-gray-400 mt-6">미래 날짜를 넣으면 D-day로, 지난 날짜를 넣으면 N일째로 보여줘요.</p>
    </div>
  );
}

// ── PIN 입력 ─────────────────────────────────────────
function PinModal({ font, mode, pin, onClose, onOk }) {
  const [v, setV] = useState("");
  const [v2, setV2] = useState("");
  const [err, setErr] = useState("");
  const isSet = mode === "set";
  const submit = () => {
    if (!/^\d{4,6}$/.test(v)) return setErr("숫자 4~6자리로 입력해 주세요.");
    if (isSet) { if (v !== v2) return setErr("두 번 입력한 PIN이 달라요."); return onOk(v); }
    if (v !== pin) return setErr("PIN이 맞지 않아요.");
    onOk(v);
  };
  const box = "w-full text-center text-2xl tracking-[0.5em] rounded-xl border border-gray-200 px-3 py-2 focus:outline-none focus:border-gray-900";
  return (
    <div style={font} className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-t-3xl p-5" style={{ paddingBottom: "calc(2rem + env(safe-area-inset-bottom))" }} onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-1">{isSet ? "시크릿 PIN 만들기" : "시크릿 잠금 해제"}</h3>
        <p className="text-xs text-gray-400 mb-4">{isSet ? "앱을 다시 열면 자동으로 잠겨요. PIN은 이 기기에만 저장돼요." : "PIN을 입력하면 시크릿 항목이 보여요."}</p>
        <input type="password" inputMode="numeric" autoFocus value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} placeholder="PIN" className={box} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {isSet && <input type="password" inputMode="numeric" value={v2} onChange={(e) => setV2(e.target.value.replace(/\D/g, ""))} placeholder="한 번 더" className={box + " mt-2"} onKeyDown={(e) => e.key === "Enter" && submit()} />}
        {err && <p className="text-xs text-red-500 mt-2">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-3.5 rounded-xl border border-gray-200 text-gray-600 text-base">취소</button>
          <button onClick={submit} className="flex-1 py-3.5 rounded-xl text-white font-semibold text-base" style={{ background: "#1F2A26" }}>{isSet ? "저장" : "열기"}</button>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<DayCounter />);
