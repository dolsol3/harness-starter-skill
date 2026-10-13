// 질문 페이지: 장부를 사람이 읽는 HTML 한 장으로 그린다. 장부를 쓰는 명령이 끝날 때마다 harness/questions.html로 다시 쓰고,
// 서버(serve.mjs)는 보낼 때마다 새로 그린다. 외부 파일 없이 한 장이다. 장부의 글은 모두 이스케이프한다(AI가 쓴 글이 화면에서 코드로 돌지 않게).
// 순서: 알아서 처리한 것 → 결정할 것 → 답한 것 → 덧댄 곳 → 진행 현황. 답은 서버로 보낸다(주소의 ?token=… 을 그대로 실어 보낸다).
import fs from 'node:fs';
import path from 'node:path';
import { openQuestions } from './ledger.mjs';
import { 행동설명 } from './questions.mjs';
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
      note.textContent = '서버에 닿지 않았습니다. node harness/backlog.mjs 서버로 연 주소에서 답해 주세요.';
      send.disabled = false;
    }
  });
}`;

const count = (book, state) => book.작업.filter(task => task.상태 === state).length;
const empty = text => `<p class="sub">${text}</p>`;

function tiles(book, waiting, patched) {
  const items = [
    ['결정할 것', waiting, '#decide', waiting > 0],
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

function questionCard(item) {
  const options = item.보기.map(choice => `<label class="option"><input type="radio" name="${esc(item.번호)}" value="${esc(choice.이름)}">
<span><b>${esc(choice.이름)}</b>${choice.이름 === item.추천 ? '<em>추천</em>' : ''}<small>고르면: ${esc(choice.결과)}</small></span></label>`).join('');
  return `<article class="card" data-q="${esc(item.번호)}" data-stamp="${esc(item.만든시각)}">
<header><span class="tag">${esc(item.행동)}</span><span class="ref">${esc(item.번호)} · ${esc(item.작업)}</span></header>
<h3>${esc(item.제목)}</h3><p>${esc(item.설명)}</p>
<p class="why">${esc(행동설명[item.행동])}이라 사람이 정합니다.</p>
${options}
<p class="why"><b>추천한 이유</b> ${esc(item.이유)}</p>
<textarea placeholder="보기에 없으면 여기에 직접 적어 주세요"></textarea>
<button type="button">답 보내기</button><output></output></article>`;
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
  const waiting = book.질문.filter(item => item.상태 === '대기');
  const answered = book.질문.filter(item => item.상태 === '답함');
  const handled = [...book.처리함].reverse();
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>작업 장부</title><style>${STYLE}</style></head><body><main>
<h1>작업 장부</h1>
<p class="sub">마지막 갱신 ${esc(now.toLocaleString('ko-KR'))}</p>
<p class="hint">이 페이지는 저절로 새로 고쳐지지 않습니다. 새 질문이 올라왔는지 보려면 새로 고침하세요.</p>
${tiles(book, waiting.length, patched.length)}
<h2 id="handled">알아서 처리한 것 ${handled.length}개</h2>
<p class="hint">정하는 사람이 필요 없다고 보고 AI가 정한 일입니다. 되돌리고 싶은 것이 있으면 알려 주세요.</p>
${handled.length ? handled.map(handledCard).join('') : empty('아직 없습니다.')}
<h2 id="decide">결정할 것 ${waiting.length}개</h2>
${waiting.length ? waiting.map(questionCard).join('') : empty('지금 정할 것이 없습니다.')}
<h2 id="answered">답한 것 ${answered.length}개</h2>
${answered.length ? `<table class="answers">${answered.map(item => `<tr><td class="ref">${esc(item.번호)}</td><td>${esc(item.제목)}</td><td>→ <b>${esc(item.답)}</b>${item.직접 ? ' (직접 적음)' : ''}</td></tr>`).join('')}</table>` : empty('아직 없습니다.')}
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
