// 질문 페이지: 장부를 사람이 읽는 HTML 한 장으로 그린다. 장부를 쓰는 명령이 끝날 때마다 harness/questions.html로 다시 쓰고,
// 서버(serve.mjs)는 보낼 때마다 새로 그린다. 외부 파일 없이 한 장이다. 장부의 글은 모두 이스케이프한다(AI가 쓴 글이 화면에서 코드로 돌지 않게).
// 순서: 허락할 것 → 확인할 것 → 고칠 것 → 답한 것 → 기록(날짜별로 접은 하루 요약) → 덧댄 곳 → 진행 현황. 답은 서버로 보낸다(주소의 ?token=… 을 그대로 실어 보낸다).
import fs from 'node:fs';
import path from 'node:path';
import { openQuestions } from './ledger.mjs';
import { 행동설명, 까닭설명, 확인기한, shownState } from './questions.mjs';
import { signals } from './patch.mjs';

const esc = text =>
  String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const STYLE = `
:root{--bg:#f5f6f8;--card:#fff;--ink:#1c2128;--sub:#5b6573;--line:#dde1e7;--accent:#2557d6;--hot:#b8420a;--hotbg:#fff3ea;--ok:#17734a}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--ink:#e8ebf0;--sub:#9aa5b4;--line:#2d333c;--accent:#7aa2ff;--hot:#ff9a62;--hotbg:#2a1f18;--ok:#4cc38a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.2rem;margin:36px 0 12px}h3{font-size:1.05rem;margin:20px 0 6px}.card h3{margin:0 0 6px}
.sub,.hint,small{color:var(--sub)}.hint{font-size:.9rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:18px 0}
.tile{display:block;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:10px;color:var(--ink);text-decoration:none}
.tile b{display:block;font-size:1.6rem;line-height:1.2}.tile.hot{background:var(--hotbg);border-color:var(--hot)}.tile.hot b{color:var(--hot)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 14px}
.card header{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.tag{font-size:.8rem;padding:1px 8px;border-radius:99px;border:1px solid var(--hot);color:var(--hot)}
.ref{font-size:.85rem;color:var(--sub)}
.why{font-size:.92rem;color:var(--sub);margin:6px 0}
.option{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin:8px 0;cursor:pointer}
.option:has(input:checked){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.option small{display:block}.option em{font-style:normal;font-size:.78rem;margin-left:8px;color:var(--ok);border:1px solid var(--ok);border-radius:99px;padding:0 7px}
textarea{width:100%;min-height:64px;margin:6px 0;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
button{font:inherit;padding:8px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}button:disabled{opacity:.5}.card.done{opacity:.6}
output{margin-left:10px;font-size:.92rem}
table{width:100%;border-collapse:collapse;font-size:.92rem;table-layout:fixed}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
td:first-child,th:first-child{width:72px}.tasks th:nth-child(3){width:26%}.tasks th:nth-child(4){width:18%}.answers td:last-child{width:34%}
.patch td:first-child,.patch th:first-child{width:34%}.patch th:nth-child(2){width:64px}
details>summary{cursor:pointer;margin:8px 0}
`;

const SCRIPT = `
const token = new URLSearchParams(location.search).get('token');
for (const card of document.querySelectorAll('[data-q]')) {
  const note = card.querySelector('output');
  const send = card.querySelector('button');
  card.addEventListener('input', event => { card.dataset.last = event.target.matches('textarea') ? 'own' : 'pick'; });
  send.addEventListener('click', async () => {
    const picked = card.querySelector('input:checked')?.value ?? '';
    const own = card.querySelector('textarea').value.trim();
    if (!picked && !own) { note.textContent = '보기 하나를 고르거나, 직접 적어 주세요.'; return; }
    const typed = Boolean(own) && (card.dataset.last === 'own' || !picked);
    send.disabled = true;
    try {
      const response = await fetch('/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, 번호: card.dataset.q, 만든시각: card.dataset.stamp, 선택: typed ? '' : picked, 직접: typed ? own : '' }) });
      note.textContent = (await response.json()).메시지;
      send.disabled = response.ok;
      if (response.ok) {
        card.classList.add('done');
        card.querySelectorAll('input, textarea').forEach(item => { item.disabled = true; });
      }
    } catch {
      note.textContent = '서버에 닿지 않았습니다. 켜 둔 질문 페이지 링크(AI가 알려 준 링크나 즐겨찾기)에서 답해 주세요. 페이지가 꺼져 있으면 AI에게 다시 켜 달라고 해 주세요.';
      send.disabled = false;
    }
  });
}`;

const count = (book, state) => book.작업.filter(task => task.상태 === state).length;
const empty = text => `<p class="sub">${text}</p>`;

// 날짜는 이 컴퓨터 시간대로 보인다.
const pad = number => String(number).padStart(2, '0');
const day = time => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
const minute = time => `${day(time)} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
const deadline = item => new Date(Date.parse(item.만든시각) + 확인기한);

// 사람이 볼 일(허락·확인·고칠 것·덧댄 곳)은 0보다 크면 강조한다. 기록은 읽을 목록이 아니라 칸을 두지 않는다.
function tiles(book, permits, confirms, fixes, patched) {
  const items = [
    ['허락할 것', permits, '#permit', permits > 0],
    ['확인할 것', confirms, '#confirm', confirms > 0],
    ['고칠 것', fixes, '#fix', fixes > 0],
    ['덧댄 곳', patched, '#patch', patched > 0],
    ['병합 대기', count(book, '올림'), '#progress', false],
    ['진행중', count(book, '진행중'), '#progress', false],
    ['할일', count(book, '할일'), '#progress', false],
    ['완료', count(book, '완료'), '#progress', false],
  ];
  return `<nav class="tiles">${items.map(([label, n, link, hot]) => `<a class="tile${hot ? ' hot' : ''}" href="${link}"><b>${n}</b>${label}</a>`).join('')}</nav>`;
}

const handledCard = item => `<article class="card"><header><span class="ref">${esc(item.작업)}</span></header>
<h3>${esc(item.제목)}</h3><p>${esc(item.설명)}</p><p class="why"><b>이유</b> ${esc(item.이유)}</p></article>`;

// 허락과 확인이 함께 쓰는 답하는 카드. notes는 꼬리표와 보기 사이에 들어가는 설명 줄이다.
function answerCard(item, tag, notes) {
  const options = item.보기.map(choice => `<label class="option"><input type="radio" name="${esc(item.번호)}" value="${esc(choice.이름)}">
<span><b>${esc(choice.이름)}</b>${choice.이름 === item.추천 ? '<em>추천</em>' : ''}<small>고르면: ${esc(choice.결과)}</small></span></label>`).join('');
  return `<article class="card" data-q="${esc(item.번호)}" data-stamp="${esc(item.만든시각)}">
<header><span class="tag">${tag}</span><span class="ref">${esc(item.번호)} · ${esc(item.작업)}</span></header>
<h3>${esc(item.제목)}</h3><p>${esc(item.설명)}</p>
${notes}${options}
<p class="why"><b>추천한 이유</b> ${esc(item.이유)}</p>
<textarea placeholder="보기에 없으면 여기에 직접 적어 주세요"></textarea>
<button type="button">답 보내기</button><output></output></article>`;
}

const reasonLine = item => (item.까닭 ? `<p class="why"><b>까닭</b> ${esc(item.까닭)} — ${esc(까닭설명[item.까닭])}</p>\n` : '');

const permitCard = item => answerCard(item, esc(item.행동), `<p class="why">${esc(행동설명[item.행동])}이라 사람이 정합니다.</p>\n${reasonLine(item)}`);

const confirmCard = item => answerCard(item, '확인', `${reasonLine(item)}<p class="why">AI가 추천한 보기(<b>${esc(item.추천)}</b>)대로 진행하고 있습니다. <b>기한</b> ${esc(minute(deadline(item)))}까지 답이 없으면 추천대로 확정되고, 다른 보기를 고르면 고칠 것으로 남습니다.</p>\n`);

const fixCard = item => `<article class="card"><header><span class="tag">고칠 것</span><span class="ref">${esc(item.번호)} · ${esc(item.작업)}</span></header>
<h3>${esc(item.제목)}</h3><p>AI가 진행한 것 <b>${esc(item.추천)}</b> → 사람의 답 <b>${esc(item.답)}</b>${item.직접 ? ' (직접 적음)' : ''}</p></article>`;

const settledCard = item => `<article class="card"><header><span class="ref">${esc(item.번호)} · ${esc(item.작업)}</span></header>
<h3>${esc(item.제목)}</h3><p>→ <b>${esc(item.추천)}</b> <span class="sub">기한이 지나 추천대로 확정</span></p></article>`;

// 날짜 하나를 접은 묶음. 요약 줄에는 그날의 기록 수와 확정 수(0이면 뺀다)를 적는다.
function fold(label, items) {
  const counts = ['기록', '확정'].map(kind => [kind, items.filter(item => item.kind === kind).length]).filter(([, n]) => n > 0);
  const summary = [esc(label), ...counts.map(([kind, n]) => `${kind} ${n}개`)].join(' · ');
  return `<details><summary>${summary}</summary>${items.map(item => item.html).join('')}</details>`;
}

// 기록과 확정된 확인을 날짜별로 접는다(새 날짜·새 항목이 위). 확정의 날짜는 기한이 지난 때다. 만든시각이 없는 옛 기록은 맨 아래 한 묶음.
function records(book, settled) {
  const dated = [
    ...book.처리함.filter(item => item.만든시각).map(item => ({ time: new Date(item.만든시각), kind: '기록', html: handledCard(item) })),
    ...settled.map(item => ({ time: deadline(item), kind: '확정', html: settledCard(item) })),
  ].sort((a, b) => b.time - a.time);
  const groups = Map.groupBy(dated, item => day(item.time));
  const undated = book.처리함.filter(item => !item.만든시각).reverse().map(item => ({ kind: '기록', html: handledCard(item) }));
  if (undated.length) groups.set('날짜 없음', undated);
  return [...groups].map(([label, items]) => fold(label, items)).join('') || empty('아직 없습니다.');
}

function taskTable(book, tasks) {
  const rows = tasks.map(task => {
    const mark = openQuestions(book, task.번호).map(item => ` <span class="tag">${esc(item.번호)} 답 대기</span>`).join('');
    const who = [task.배정 && `배정 ${task.배정}`, task.검토 && `검토 ${task.검토}`].filter(Boolean).join(', ');
    return `<tr><td class="ref">${esc(task.번호)}</td><td>${esc(task.제목)}${mark}</td><td>${esc(task.영역.join(', '))}</td><td>${esc(who)}</td></tr>`;
  });
  return `<table class="tasks"><tr><th>번호</th><th>제목</th><th>영역</th><th>도구</th></tr>${rows.join('')}</table>`;
}

// 같은 파일을 수정 커밋으로 여러 번 고친 곳(patch.mjs). 기준은 harness/config.json의 patch에 있다.
function patchTable(patched) {
  const rows = patched.map(({ file, subjects }) => `<tr><td>${esc(file)}</td><td>${subjects.length}번</td><td>${subjects.map(esc).join('<br>')}</td></tr>`);
  return rows.length ? `<table class="patch"><tr><th>파일</th><th>횟수</th><th>수정 커밋</th></tr>${rows.join('')}</table>` : empty('지금 없습니다.');
}

function progress(book) {
  const groups = [['진행중', '진행중'], ['올림', '병합 대기 (브랜치에 올렸고 기본 브랜치에 병합되기를 기다림)'], ['할일', '할일'], ['완료', '완료']];
  const blocks = groups.map(([state, label]) => {
    const tasks = book.작업.filter(task => task.상태 === state);
    if (!tasks.length) return '';
    const table = taskTable(book, tasks);
    return state === '완료'
      ? `<details><summary>${label} ${tasks.length}개</summary>${table}</details>`
      : `<h3>${label} ${tasks.length}개</h3>${table}`;
  }).join('');
  return blocks || empty('작업이 아직 없습니다.');
}

export function render(book, now = new Date(), patched = []) {
  const shown = state => book.질문.filter(item => shownState(item, now) === state);
  const [permits, confirms, fixes, answered, settled] = ['대기', '확인중', '고칠것', '답함', '확정'].map(shown);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>작업 장부</title><style>${STYLE}</style></head><body><main>
<h1>작업 장부</h1>
<p class="sub">마지막 갱신 ${esc(now.toLocaleString('ko-KR'))}</p>
<p class="hint">이 페이지는 저절로 새로 고쳐지지 않습니다. 새 질문이 올라왔는지 보려면 새로 고침하세요.</p>
${tiles(book, permits.length, confirms.length, fixes.length, patched.length)}
<h2 id="permit">허락할 것 ${permits.length}개</h2>
<p class="hint">답이 올 때까지 그 작업만 멈춰 있습니다.</p>
${permits.length ? permits.map(permitCard).join('') : empty('지금 허락할 것이 없습니다.')}
<h2 id="confirm">확인할 것 ${confirms.length}개</h2>
<p class="hint">AI가 추천대로 먼저 진행하고 있습니다. 맞으면 추천을, 아니면 다른 보기를 골라 주세요.</p>
${confirms.length ? confirms.map(confirmCard).join('') : empty('지금 확인할 것이 없습니다.')}
<h2 id="fix">고칠 것 ${fixes.length}개</h2>
<p class="hint">사람이 추천과 다르게 답한 확인입니다. 병합 전이면 메인이 반려로, 병합 뒤면 추가로 수정 작업을 엽니다.</p>
${fixes.length ? fixes.map(fixCard).join('') : empty('지금 고칠 것이 없습니다.')}
<h2 id="answered">답한 것 ${answered.length}개</h2>
${answered.length ? `<table class="answers">${answered.map(item => `<tr><td class="ref">${esc(item.번호)}</td><td>${esc(item.제목)}</td><td>→ <b>${esc(item.답)}</b>${item.직접 ? ' (직접 적음)' : ''}</td></tr>`).join('')}</table>` : empty('아직 없습니다.')}
<h2 id="records">기록 ${book.처리함.length + settled.length}개</h2>
<p class="hint">AI가 알아서 정한 일과 기한이 지나 확정된 확인입니다. 날짜를 누르면 펼쳐집니다.</p>
${records(book, settled)}
<h2 id="patch">덧댄 곳 ${patched.length}개</h2>
<p class="hint">기본 브랜치의 최근 수정 커밋에 여러 번 들어 있는 파일입니다. 증상만 고치고 있다는 신호일 수 있으니, 이 파일을 고치는 작업은 원인이 정말 뿌리인지 먼저 확인하세요.</p>
${patchTable(patched)}
<h2 id="progress">진행 현황</h2>
${progress(book)}
</main><script>${SCRIPT}</script></body></html>
`;
}

// 장부와 git 기록을 읽어 그린 페이지. 쓰는 명령과 서버가 함께 쓴다.
export const draw = (root, book) => render(book, new Date(), signals(root));

// 신호를 이미 읽었으면(수정 작업 시작) 받아서 쓰고, 아니면 읽는다.
export function write(root, book, patched = signals(root)) {
  fs.writeFileSync(path.join(root, 'harness/questions.html'), render(book, new Date(), patched));
}
