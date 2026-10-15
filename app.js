/**
 * AI 퀴즈 메이커 — app.js
 * Gemini 1.5 Pro API를 사용하여 업로드된 강의 자료에서 퀴즈를 자동 생성합니다.
 */

/* ─────────────────────────────────────────
   상수 & 설정
───────────────────────────────────────── */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL    = 'gemini-1.5-pro-latest';
const LS_KEY_APIKEY   = 'quizapp_gemini_key';
const MAX_FILE_MB     = 20;
const MAX_CHARS       = 80000; // Gemini 입력 제한 안전값

/* ─────────────────────────────────────────
   상태
───────────────────────────────────────── */
const state = {
  apiKey:       '',
  file:         null,
  fileText:     '',
  questions:    [],   // 전체 문제 배열
  activeQs:     [],   // 현재 풀고 있는 문제 배열
  idx:          0,
  answered:     false,
  correctCount: 0,
  wrongCount:   0,
  wrongItems:   [],   // { question, userAnswer, correctAnswer, explanation }
  settings: {
    count: 100,
    type:  'mixed',
    lang:  'ko',
  },
};

/* ─────────────────────────────────────────
   DOM 참조
───────────────────────────────────────── */
const $ = id => document.getElementById(id);

const screens = {
  home:    $('screen-home'),
  loading: $('screen-loading'),
  quiz:    $('screen-quiz'),
  result:  $('screen-result'),
};

/* ─────────────────────────────────────────
   화면 전환
───────────────────────────────────────── */
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  window.scrollTo(0, 0);
}

/* ─────────────────────────────────────────
   초기화
───────────────────────────────────────── */
function init() {
  // 저장된 API 키 복원
  const saved = localStorage.getItem(LS_KEY_APIKEY);
  if (saved) {
    $('api-key-input').value = saved;
    state.apiKey = saved;
    updateGenerateBtn();
  }

  // 이벤트 연결
  $('api-key-input').addEventListener('input', onApiKeyInput);
  $('btn-toggle-key').addEventListener('click', toggleKeyVisibility);
  $('file-input').addEventListener('change', onFileSelect);
  $('btn-remove-file').addEventListener('click', removeFile);
  $('btn-generate').addEventListener('click', startGeneration);
  $('btn-next').addEventListener('click', nextQuestion);
  $('btn-retry-wrong').addEventListener('click', retryWrong);
  $('btn-retry-all').addEventListener('click', retryAll);
  $('btn-new-quiz').addEventListener('click', goHome);
  $('sel-count').addEventListener('change', e => { state.settings.count = +e.target.value; });
  $('sel-type').addEventListener('change',  e => { state.settings.type  =  e.target.value; });
  $('sel-lang').addEventListener('change',  e => { state.settings.lang  =  e.target.value; });

  // 드래그앤드롭
  const zone = $('upload-zone');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  showScreen('home');
}

/* ─────────────────────────────────────────
   API 키
───────────────────────────────────────── */
function onApiKeyInput(e) {
  state.apiKey = e.target.value.trim();
  localStorage.setItem(LS_KEY_APIKEY, state.apiKey);
  updateGenerateBtn();
}

function toggleKeyVisibility() {
  const inp = $('api-key-input');
  const btn = $('btn-toggle-key');
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = '🙈';
  } else {
    inp.type = 'password';
    btn.textContent = '👁️';
  }
}

/* ─────────────────────────────────────────
   파일 처리
───────────────────────────────────────── */
function onFileSelect(e) {
  const f = e.target.files[0];
  if (f) handleFile(f);
}

function handleFile(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  const allowed = ['pdf', 'txt', 'md', 'csv'];
  if (!allowed.includes(ext)) {
    showError('지원하지 않는 파일 형식입니다. PDF, TXT, MD, CSV 파일을 업로드해 주세요.');
    return;
  }
  if (f.size > MAX_FILE_MB * 1024 * 1024) {
    showError(`파일 크기가 너무 큽니다. ${MAX_FILE_MB}MB 이하의 파일을 사용해 주세요.`);
    return;
  }
  hideError();
  state.file = f;

  // 아이콘
  const icons = { pdf: '📕', txt: '📄', md: '📝', csv: '📊' };
  $('file-icon').textContent = icons[ext] || '📄';
  $('file-name').textContent = f.name;
  $('file-size').textContent = formatSize(f.size);
  $('file-preview').classList.remove('hidden');
  $('upload-zone').style.display = 'none';
  updateGenerateBtn();
}

function removeFile() {
  state.file = null;
  state.fileText = '';
  $('file-input').value = '';
  $('file-preview').classList.add('hidden');
  $('upload-zone').style.display = '';
  updateGenerateBtn();
}

function formatSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* ─────────────────────────────────────────
   버튼 활성화 조건
───────────────────────────────────────── */
function updateGenerateBtn() {
  const ok = state.apiKey.length > 10 && state.file !== null;
  $('btn-generate').disabled = !ok;
}

/* ─────────────────────────────────────────
   퀴즈 생성 시작
───────────────────────────────────────── */
async function startGeneration() {
  hideError();
  showScreen('loading');
  setStep(1);

  try {
    // 1. 파일 텍스트 추출
    state.fileText = await extractText(state.file);
    if (!state.fileText.trim()) {
      throw new Error('파일에서 텍스트를 추출할 수 없습니다. 다른 파일을 시도해 보세요.');
    }
    // 텍스트 길이 제한
    if (state.fileText.length > MAX_CHARS) {
      state.fileText = state.fileText.slice(0, MAX_CHARS);
    }
    markStep(1);

    // 2. Gemini API 호출
    setStep(2);
    const raw = await callGemini(state.fileText, state.settings);
    markStep(2);

    // 3. 파싱
    setStep(3);
    const qs = parseQuestions(raw);
    if (!qs || qs.length === 0) {
      throw new Error('문제를 생성하지 못했습니다. 다시 시도하거나 다른 파일을 사용해 보세요.');
    }
    state.questions = qs;
    markStep(3);

    // 4. 완료
    setStep(4);
    markStep(4);

    await delay(600);
    startQuiz(state.questions);

  } catch (err) {
    showScreen('home');
    showError(err.message || '알 수 없는 오류가 발생했습니다.');
  }
}

/* ─────────────────────────────────────────
   로딩 스텝 UI
───────────────────────────────────────── */
function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = $(`step-${i}`);
    el.classList.remove('active', 'done');
    if (i === n) el.classList.add('active');
  }
}
function markStep(n) {
  const el = $(`step-${n}`);
  el.classList.remove('active');
  el.classList.add('done');
  el.querySelector('.step-dot').textContent = '✓';
}

/* ─────────────────────────────────────────
   파일 텍스트 추출
───────────────────────────────────────── */
async function extractText(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'pdf') {
    return await extractPdfText(file);
  } else {
    // TXT, MD, CSV → 그냥 읽기
    return await readAsText(file);
  }
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('파일을 읽을 수 없습니다.'));
    reader.readAsText(file, 'UTF-8');
  });
}

async function extractPdfText(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    pages.push(`[페이지 ${i}]\n${pageText}`);
  }
  return pages.join('\n\n');
}

/* ─────────────────────────────────────────
   Gemini API 호출
───────────────────────────────────────── */
async function callGemini(text, settings) {
  const prompt = buildPrompt(text, settings);
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${state.apiKey}`;

  const body = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    const msg = errData?.error?.message || `API 오류 (HTTP ${resp.status})`;
    if (resp.status === 400) throw new Error('API 키가 올바르지 않습니다. 키를 확인해 주세요.');
    if (resp.status === 429) throw new Error('요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    throw new Error(msg);
  }

  const data = await resp.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('AI 응답이 비어 있습니다. 다시 시도해 주세요.');
  return raw;
}

/* ─────────────────────────────────────────
   프롬프트 작성
───────────────────────────────────────── */
function buildPrompt(text, settings) {
  const { count, type, lang } = settings;
  const langName = lang === 'ko' ? '한국어' : 'English';

  const typeInstr =
    type === 'ox' ? '모든 문제를 O/X 진위형으로만 출제하세요.' :
    type === 'mc' ? '모든 문제를 객관식으로만 출제하세요.' :
    `O/X 진위형 약 30%, 객관식(빈칸 채우기 25%, 개념 설명 고르기 25%, 학자/이론 관련 20%) 비율로 출제하세요.`;

  return `
당신은 교육 전문가이자 퀴즈 출제 전문가입니다.
아래 강의 자료를 분석하여 정확하고 다양한 퀴즈를 ${count}문제 생성하세요.

━━━ 출제 규칙 ━━━
1. 반드시 제공된 자료에 근거한 문제만 출제하세요. 자료에 없는 내용은 절대 출제하지 마세요.
2. ${typeInstr}
3. 단순 암기뿐 아니라 개념 이해·응용 문제도 포함하세요.
4. X 문제(틀린 진술)는 어느 부분이 틀렸는지 명확하게 구분되도록 작성하세요.
5. 정답이 애매하거나 다중 해석이 가능한 문제는 출제하지 마세요.
6. 비슷한 문제를 반복하지 말고 자료 전체 범위를 고르게 출제하세요.
7. 모든 문제·선택지·해설은 ${langName}로 작성하세요.
8. 객관식은 반드시 4개의 선택지를 제공하세요.

━━━ 출력 형식 ━━━
반드시 아래 JSON 배열 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

[
  {
    "id": 1,
    "type": "ox",
    "question": "문제 내용",
    "correct": "O",
    "explanation": "해설 (2~4문장, 왜 O인지 또는 X인지 명확하게)",
    "reference": "페이지 번호 또는 절 제목 (알 수 있는 경우)"
  },
  {
    "id": 2,
    "type": "mc",
    "subtype": "blank",
    "question": "빈칸이 있는 문장: ___는 XXX 이론을 주장했다.",
    "options": ["①선택지A", "②선택지B", "③선택지C", "④선택지D"],
    "correct": "①선택지A",
    "explanation": "해설",
    "reference": "페이지 또는 절"
  },
  {
    "id": 3,
    "type": "mc",
    "subtype": "concept",
    "question": "XXX에 대한 설명으로 옳은 것은?",
    "options": ["①...", "②...", "③...", "④..."],
    "correct": "②...",
    "explanation": "해설",
    "reference": "페이지 또는 절"
  },
  {
    "id": 4,
    "type": "mc",
    "subtype": "scholar",
    "question": "XXX 학자가 주장한 내용이 아닌 것은?",
    "options": ["①...", "②...", "③...", "④..."],
    "correct": "③...",
    "explanation": "해설",
    "reference": "페이지 또는 절"
  }
]

subtype 값: "blank" (빈칸 채우기) | "concept" (개념 설명) | "scholar" (학자/이론) | "other" (기타)

━━━ 강의 자료 ━━━
${text}
`.trim();
}

/* ─────────────────────────────────────────
   JSON 파싱
───────────────────────────────────────── */
function parseQuestions(raw) {
  // JSON 블록 추출 (마크다운 코드블록 처리)
  let jsonStr = raw.trim();
  const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) jsonStr = match[1].trim();

  // 배열 시작 위치 찾기
  const start = jsonStr.indexOf('[');
  const end   = jsonStr.lastIndexOf(']');
  if (start !== -1 && end !== -1) {
    jsonStr = jsonStr.slice(start, end + 1);
  }

  try {
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) throw new Error();
    // 유효성 검사 + 정규화
    return arr.filter(q => q && q.type && q.question && q.correct).map((q, i) => ({
      id:          q.id || (i + 1),
      type:        q.type,          // 'ox' | 'mc'
      subtype:     q.subtype || '',
      question:    q.question,
      options:     q.options || [],
      correct:     q.correct,
      explanation: q.explanation || '',
      reference:   q.reference || '',
    }));
  } catch {
    // JSON 파싱 실패 시 재시도 없이 에러
    throw new Error('AI 응답을 처리하지 못했습니다. 다시 시도해 주세요.');
  }
}

/* ─────────────────────────────────────────
   퀴즈 시작
───────────────────────────────────────── */
function startQuiz(questions) {
  state.activeQs    = shuffle([...questions]);
  state.idx         = 0;
  state.answered    = false;
  state.correctCount = 0;
  state.wrongCount  = 0;
  state.wrongItems  = [];

  showScreen('quiz');
  renderQuestion();
}

/* ─────────────────────────────────────────
   문제 렌더링
───────────────────────────────────────── */
function renderQuestion() {
  const q = state.activeQs[state.idx];
  state.answered = false;
  $('btn-next').classList.add('hidden');

  // 헤더
  const total = state.activeQs.length;
  const pct   = (state.idx / total) * 100;
  $('progress-fill').style.width = pct + '%';
  $('quiz-count').textContent    = `${state.idx + 1}/${total}`;
  $('hdr-correct').textContent   = state.correctCount;
  $('hdr-wrong').textContent     = state.wrongCount;

  // 본문
  const body = $('quiz-body');

  if (q.type === 'ox') {
    body.innerHTML = renderOX(q);
    document.getElementById('btn-ox-o').addEventListener('click', () => answerOX(q, 'O'));
    document.getElementById('btn-ox-x').addEventListener('click', () => answerOX(q, 'X'));
  } else {
    body.innerHTML = renderMC(q);
    const optBtns = body.querySelectorAll('.btn-option');
    optBtns.forEach(btn => {
      btn.addEventListener('click', () => answerMC(q, btn.dataset.value, optBtns));
    });
  }
}

function renderOX(q) {
  const badge = '<span class="q-type-badge badge-ox">⭕❌ O / X 진위형</span>';
  return `
    <div class="question-card">
      ${badge}
      <div class="q-text">${escHtml(q.question)}</div>
    </div>
    <div class="ox-buttons">
      <button class="btn-ox btn-ox-o" id="btn-ox-o">
        ⭕<span>맞다 (O)</span>
      </button>
      <button class="btn-ox btn-ox-x" id="btn-ox-x">
        ❌<span>틀리다 (X)</span>
      </button>
    </div>
    <div id="feedback-area"></div>
  `;
}

function renderMC(q) {
  const subtypeLabels = {
    blank:   '📝 빈칸 채우기',
    concept: '💡 개념 이해',
    scholar: '🎓 학자 / 이론',
    other:   '📋 객관식',
    '':      '📋 객관식',
  };
  const label = subtypeLabels[q.subtype] || '📋 객관식';
  const badge = `<span class="q-type-badge badge-mc">${label}</span>`;

  // 선택지 셔플 (정답 추적)
  const shuffled = shuffle([...q.options]);
  const opts = shuffled.map(opt => `
    <button class="btn-option" data-value="${escAttr(opt)}">
      <div class="option-num">${optNumLabel(opt)}</div>
      <div class="option-text">${escHtml(stripNum(opt))}</div>
    </button>
  `).join('');

  return `
    <div class="question-card">
      ${badge}
      <div class="q-text">${escHtml(q.question)}</div>
    </div>
    <div class="mc-options">${opts}</div>
    <div id="feedback-area"></div>
  `;
}

function optNumLabel(opt) {
  const m = opt.match(/^([①②③④⑤])/);
  return m ? m[1] : '●';
}
function stripNum(opt) {
  return opt.replace(/^[①②③④⑤]\s*/, '');
}

/* ─────────────────────────────────────────
   답변 처리
───────────────────────────────────────── */
function answerOX(q, chosen) {
  if (state.answered) return;
  state.answered = true;

  const isCorrect = chosen === q.correct.toUpperCase();
  const oBtn = document.getElementById('btn-ox-o');
  const xBtn = document.getElementById('btn-ox-x');

  oBtn.classList.add('disabled');
  xBtn.classList.add('disabled');

  if (chosen === 'O') {
    oBtn.classList.add(isCorrect ? 'correct' : 'wrong');
    if (!isCorrect) xBtn.classList.add('correct');
  } else {
    xBtn.classList.add(isCorrect ? 'correct' : 'wrong');
    if (!isCorrect) oBtn.classList.add('correct');
  }

  recordResult(q, chosen, isCorrect);
  showFeedback(q, isCorrect);
}

function answerMC(q, chosen, allBtns) {
  if (state.answered) return;
  state.answered = true;

  const isCorrect = chosen === q.correct;

  allBtns.forEach(btn => {
    btn.classList.add('disabled');
    if (btn.dataset.value === q.correct)  btn.classList.add('correct');
    else if (btn.dataset.value === chosen) btn.classList.add('wrong');
  });

  recordResult(q, chosen, isCorrect);
  showFeedback(q, isCorrect);
}

function recordResult(q, chosen, isCorrect) {
  if (isCorrect) {
    state.correctCount++;
  } else {
    state.wrongCount++;
    state.wrongItems.push({
      question:    q.question,
      userAnswer:  chosen,
      correct:     q.correct,
      explanation: q.explanation,
    });
  }
  $('hdr-correct').textContent = state.correctCount;
  $('hdr-wrong').textContent   = state.wrongCount;
}

function showFeedback(q, isCorrect) {
  const area = $('feedback-area');
  const cls  = isCorrect ? 'correct' : 'wrong';
  const icon = isCorrect ? '🎉' : '😢';
  const msg  = isCorrect ? '정답입니다!' : '오답입니다.';
  const ref  = q.reference
    ? `<div class="feedback-ref">📖 <span>${escHtml(q.reference)}</span></div>`
    : '';

  area.innerHTML = `
    <div class="feedback-card ${cls}">
      <div class="feedback-result">${icon} ${msg}</div>
      <div class="feedback-explain">${escHtml(q.explanation)}</div>
      ${ref}
    </div>
  `;

  // 마지막 문제라면 버튼 텍스트 변경
  const isLast = state.idx >= state.activeQs.length - 1;
  const btn    = $('btn-next');
  btn.textContent = isLast ? '🏆 결과 보기' : '다음 문제 →';
  btn.classList.remove('hidden');

  // 스크롤
  setTimeout(() => {
    area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

/* ─────────────────────────────────────────
   다음 문제 / 결과
───────────────────────────────────────── */
function nextQuestion() {
  state.idx++;
  if (state.idx >= state.activeQs.length) {
    showResult();
  } else {
    renderQuestion();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

/* ─────────────────────────────────────────
   결과 화면
───────────────────────────────────────── */
function showResult() {
  showScreen('result');

  const total   = state.activeQs.length;
  const correct = state.correctCount;
  const wrong   = state.wrongCount;
  const pct     = Math.round((correct / total) * 100);

  // 원형 점수
  $('score-circle').style.setProperty('--pct', `${pct}%`);
  $('score-pct').textContent = pct + '%';

  $('stat-total').textContent   = total;
  $('stat-correct').textContent = correct;
  $('stat-wrong').textContent   = wrong;

  // 원형 그라디언트 업데이트
  $('score-circle').style.background =
    `conic-gradient(var(--accent) ${pct}%, var(--border) 0%)`;

  // 오답 복습 버튼
  if (state.wrongItems.length > 0) {
    $('btn-retry-wrong').style.display = '';
    $('wrong-section').style.display   = '';
    renderWrongList();
  } else {
    $('btn-retry-wrong').style.display = 'none';
    $('wrong-section').style.display   = 'none';
  }
}

function renderWrongList() {
  const list = $('wrong-list');
  list.innerHTML = state.wrongItems.map((item, i) => `
    <div class="wrong-item">
      <div class="wrong-q">Q${i+1}. ${escHtml(item.question)}</div>
      <div class="wrong-answer-row">
        <span class="wrong-your">내 답: ${escHtml(item.userAnswer)}</span>
        <span class="arrow">→</span>
        <span class="wrong-correct">정답: ${escHtml(item.correct)}</span>
      </div>
      <div class="wrong-explain">${escHtml(item.explanation)}</div>
    </div>
  `).join('');
}

/* ─────────────────────────────────────────
   다시 풀기
───────────────────────────────────────── */
function retryWrong() {
  if (state.wrongItems.length === 0) return;
  // wrongItems → 문제 배열로 재구성
  const wrongQs = state.wrongItems.map((item, i) => {
    // 원본 문제에서 찾기
    const orig = state.questions.find(q => q.question === item.question);
    return orig || {
      id: i + 1, type: 'mc', subtype: 'other',
      question: item.question, options: [], correct: item.correct,
      explanation: item.explanation, reference: ''
    };
  });
  startQuiz(wrongQs);
}

function retryAll() {
  startQuiz(state.questions);
}

function goHome() {
  showScreen('home');
}

/* ─────────────────────────────────────────
   에러 UI
───────────────────────────────────────── */
function showError(msg) {
  $('error-text').textContent = msg;
  $('error-banner').classList.remove('hidden');
  $('error-banner').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideError() {
  $('error-banner').classList.add('hidden');
}

/* ─────────────────────────────────────────
   토스트
───────────────────────────────────────── */
function showToast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ─────────────────────────────────────────
   유틸
───────────────────────────────────────── */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttr(str = '') {
  return escHtml(str);
}

/* ─────────────────────────────────────────
   START
───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
