import { TheatreApp } from "./TheatreApp.js";
import {
  MODULE_ID,
  SOCKET_NAME,
  getRenderTemplateFn,
  getLoadTemplatesFn,
  getChatPortraitCropStyle,
  getChatPortraitDisplayStyle,
  DEFAULT_CHAT_PORTRAIT_SIZE,
  DEFAULT_CHAT_PORTRAIT_ROUNDNESS,
  MAX_STANDING_CHANNELS,
  normalizeStandingEligibleChannels,
  getChatChannelsApi,
  getActiveStandingChannelId,
  getChatPortraitPreset,
  getTheatreChatText,
  STANDING_MAIN_CHANNEL_ID,
  toRealChannelId,
  fromRealChannelId,
  migrateChannelStateMap,
  pruneChannelStateMap,
  getLastExpressionForChannel,
  setLastExpressionForChannel
} from "./module-config.js";

export { MODULE_ID, SOCKET_NAME, getRenderTemplateFn, getLoadTemplatesFn, getChatChannelsApi };
const LOG_PREFIX = "[Custom Theatre]";

export let theatreApp = null;

// ── [1-C, v1.7.35] custom-chat-channels 국소 예외 화이트리스트 ──────────────
// whisper를 채널 격리 수단으로 쓰는 custom-chat-channels 모듈이 보내는 메시지는
// whisper 배열이 채워져 있어도 진짜 개인 귓속말이 아니다. 그 모듈이 메시지에 심는
// channelId flag가 있는 경우에 한해서만, 아래 채팅 초상화 관련 두 지점
// (getChatPortraitInfo, preCreateChatMessage 훅)에서 whisper 스킵 로직의 예외로
// 취급한다. 인계 문서 1-C에 명시된 사용자 승인 범위이며, 이 두 지점 외에는 절대
// 적용하지 않는다 — 특히 아래 createChatMessage 훅(일반 채팅 자동 감지/스탠딩 표시)의
// whisper 스킵은 이 예외와 무관하게 그대로 유지한다(Phase 3에서 별도 이벤트로 처리 예정).
//
// custom-chat-channels 모듈이 설치/활성화되어 있지 않은 환경에서는 getFlag가 그냥
// undefined를 반환하므로 항상 false가 되어 기존 동작(귓속말 제외)과 완전히 동일하다.
const CHAT_CHANNELS_MODULE_ID = "custom-chat-channels";
const CHAT_CHANNELS_FLAG_KEY = "channelId";

function isChatChannelsMessage(message) {
  const channelId = message.getFlag(CHAT_CHANNELS_MODULE_ID, CHAT_CHANNELS_FLAG_KEY);
  return typeof channelId === "string" && channelId.length > 0;
}

/**
 * [후속 버그 수정 - 문제 2] 메시지가 속한 채널을 내부 식별자(메인이면 STANDING_MAIN_CHANNEL_ID)로
 * 반환한다. applyChatPortraitDisplay()가 "같은 채널의 직전 메시지"를 찾을 때 쓴다.
 * (기존에 1056행 부근에서 쓰던 것과 동일한 패턴을 헬퍼로 뽑아낸 것)
 */
function getMessageChannelId(message) {
  const realChannelId = message.getFlag(CHAT_CHANNELS_MODULE_ID, CHAT_CHANNELS_FLAG_KEY) || "";
  return fromRealChannelId(realChannelId);
}

// ── [Phase 3] custom-chat-channels 연동 (스탠딩 채널 버튼) ──────────────────
// custom-chat-channels가 설치/활성화되어 있지 않으면 null을 반환하며, 호출부는
// 이 경우 채널 버튼 UI 자체를 그리지 않는다. 정적 import 대신 game.modules.get(...).api를
// 쓰는 이유는 두 모듈이 완전히 독립된 별도 ESM이라 서로의 파일을 직접 import할 수 없기 때문
// (인계 문서 5장 "훅 기반 삽입" 원칙과 동일한 이유로, 여기서는 공개 API 객체를 그 대신 쓴다).
/**
 * [Phase 3] GM 강제 채널 전환을 이 클라이언트에 적용한다. 소켓(즉시)과 updateSetting
 * (안전망) 양쪽에서 동일하게 호출되므로, 두 경로가 겹쳐 들어와도(예: 소켓이 먼저 오고
 * 잠시 후 world 설정 갱신이 뒤따라와도) 결과가 달라지지 않도록 멱등적으로 작성한다.
 *
 * channelId가 비어 있으면(해제) — 확정 사항(인계 문서 4장)에 따라 "직전 개인 선택으로
 * 복귀"하지 않고 강제 중 보고 있던 탭을 그대로 유지한다. 즉 해제 시에는 아무 채널
 * 전환도 하지 않고, 스탠딩 버튼의 "강제 중" 표시만 지운다.
 */
async function applyForcedStandingChannel(channelId) {
  try {
    let restored = false;
    if (channelId) {
      const api = getChatChannelsApi();
      // [버그 5] channelId는 내부 식별자다(메인이면 STANDING_MAIN_CHANNEL_ID). chat-channels
      // API를 실제로 호출할 때만 toRealChannelId로 변환하고, 메인은 항상 참여 중으로
      // 간주해 isUserInChannel 검사를 건너뛴다.
      const isMain = channelId === STANDING_MAIN_CHANNEL_ID;
      if (api && (isMain || api.isUserInChannel(channelId))) {
        await api.setActiveChannel(toRealChannelId(channelId));
        await game.settings.set(MODULE_ID, "myStandingChannel", channelId).catch(() => {});
        // [버그 1] GM 강제 전환으로 튜닝 채널이 바뀌는 이 경로(소켓 수신 + updateSetting
        // 안전망)에서도, 버튼 클릭 전환과 동일하게 그 채널의 마지막 대사를 즉시 복원한다.
        restored = await (theatreApp?.restoreStandingChannelDisplay(channelId) ?? false);
      }
      // 참여 중이 아닌 채널로는 강제 전환하지 않는다(방어적) — GM이 실수로 해당
      // 플레이어가 없는 채널을 강제 지정해도 그 플레이어 화면은 그냥 변화가 없다.
    }
    // [버그 2] restoreStandingChannelDisplay가 실제로 반영했다면(=이미 render()까지
    // 끝났다면) 여기서 또 render()를 부르지 않는다. TheatreApp.js의 _onStandingChannelClick /
    // _onStandingChannelDblClick과 동일한 이유(이중 렌더가 겹쳐 스탠딩 박스가 사라지던 문제).
    if (!restored) theatreApp?.render();
  } catch (err) {
    console.error(`${LOG_PREFIX} 스탠딩 채널 강제 전환 적용 중 오류:`, err);
  }
}

/**
 * 메시지 하나에 대해 채팅 초상화 표시 정보(이미지 경로 + 병합 판단용 키)를 계산한다.
 * 귓속말, 액터 없음/삭제된 액터, 표시할 이미지가 없는 경우엔 null을 반환한다.
 * 렌더링 대상 메시지뿐 아니라 "직전 메시지"를 판단할 때도 이 함수로 동일하게
 * 재계산해서 비교하므로, 두 판단 기준이 항상 일치한다.
 */
function getChatPortraitInfo(message) {
  // 귓속말은 지원 범위 제외 (3.1). 단, custom-chat-channels의 channelId flag가 있는
  // 채널 메시지는 예외로 통과시킨다 (1-C 승인 사항, v1.7.35).
  if (message.whisper?.length && !isChatChannelsMessage(message)) return null;

  const actorId = message.speaker?.actor ?? null;
  let actor = actorId ? game.actors.get(actorId) : null;

  // 링크되지 않은(Unlinked) NPC 토큰은 game.actors에 존재하지 않는 "토큰 전용 합성
  // 액터"를 화자로 쓰기 때문에 game.actors.get()으로는 찾을 수 없다(실사용 중 확인된
  // 원인: 언링크 NPC 전투롤에서 초상화가 전혀 안 뜨던 문제). 이 경우 스피커에 담긴
  // scene/token id로 해당 토큰 문서를 찾아 그 합성 액터로 폴백한다.
  let isUnlinkedTokenActor = false;
  if (!actor && message.speaker?.token) {
    const scene = game.scenes.get(message.speaker.scene) ?? canvas.scene;
    const tokenDoc = scene?.tokens?.get(message.speaker.token) ?? null;
    actor = tokenDoc?.actor ?? null;
    if (actor) isUnlinkedTokenActor = true;
  }

  let imgSrc = message.getFlag(MODULE_ID, "expressionImg");
  let preset = null; // 크롭/배경 프리셋 (3.2/3.3) — 표정 스냅샷이 있는 경우에만 적용
  if (!imgSrc) {
    // 활성 표정이 없던 일반 메시지는 액터 기본 이미지로 폴백한다 (3.3-1).
    // 화자 액터가 이후 삭제된 과거 로그는 참조가 없으므로 대상에서 제외한다.
    // 크롭/프리셋 로직도 타지 않는다 (3.3-1, 4장).
    if (!actor?.img) return null;
    imgSrc = actor.img;
  } else if (actor) {
    preset = getChatPortraitPreset(actor, imgSrc);
  }

  // 언링크 토큰은 서로 다른 NPC 인스턴스가 같은 원본 actorId를 공유할 수 있어,
  // actorId만으로 병합 키를 만들면 서로 다른 개체가 같은 화자로 잘못 병합될 수
  // 있다. 그 경우에만 토큰 id를 함께 묶어 인스턴스 단위로 구분하고, 링크된 액터는
  // 기존과 동일하게 actorId만 사용해 병합 동작을 그대로 유지한다.
  const mergeIdentity = isUnlinkedTokenActor ? `${actorId}::token:${message.speaker.token}` : actorId;

  return { actorId, imgSrc, preset, mergeKey: `${mergeIdentity}::${imgSrc}` };
}

/**
 * 채팅 로그 항목에 표정 초상화를 그려 넣는다.
 * 2단계: 액터에 저장된 크롭 프리셋(chatPortraitPresets)이 있으면 확대/이동/배경색을 적용하고,
 * 없으면 1단계와 동일하게 원본 비율 그대로(object-fit: contain, 배경 투명) 표시한다.
 *
 * 채팅 병합(옵션 A, 화면 표시만 변경): 같은 화자 + 같은 표정 스냅샷의 메시지가
 * "직전 메시지"와 이어지면, 새 헤더/초상화를 또 그리지 않고 이번 메시지의 헤더만 숨겨서
 * 직전 카드에 이어지는 것처럼 보이게 한다. 표정이 바뀌면 자동으로 새 카드가 그려진다.
 *
 * 직전 메시지 판단은 DOM 형제 탐색이 아니라 game.messages 컬렉션(문서 데이터) 순서를
 * 기준으로 한다. (콘솔로 확인된 원인) renderChatMessageHTML 훅이 호출되는 시점엔 메시지
 * 엘리먼트가 아직 실제 채팅 로그 DOM에 삽입되기 전(별도의 임시 컨테이너 안에만 있음)이라
 * previousElementSibling으로는 직전 메시지를 절대 찾을 수 없다. game.messages는 DOM
 * 삽입 여부와 무관하게 항상 정확한 문서 순서를 가지므로 이 문제에서 자유롭다.
 *
 * 중요: ChatMessage 문서 자체는 절대 수정/병합하지 않는다(순수 화면 표시만 변경).
 * 그래서 삭제 권한, 우클릭 컨텍스트 메뉴, 판정(rolls) 데이터 등 기존 동작에는 영향이 없다.
 *
 * renderChatMessageHTML은 스크롤/재렌더 등으로 같은 메시지에 여러 번 호출될 수 있으므로,
 * "이미 이 메시지를 처리했는지"를 root 자체에 마킹해서 멱등성 가드로 관리한다.
 */
/**
 * 병합된 메시지의 상단 여백을, 실제로 하단 여백을 상쇄할 만큼 당겨준다.
 * root가 아직 실제 #chat-log DOM에 삽입되기 전이면 marginBottom을 읽을 수 없으므로
 * (연결 안 된 노드는 CSS 캐스케이드가 적용되지 않아 0으로 읽힘) 연결될 때까지 기다린다.
 *
 * v1.7.14까지는 requestAnimationFrame으로 최대 10프레임만 재시도하고 포기했는데,
 * 이 타임아웃이 문제였다: 채팅 로그 초기 로드처럼 과거 메시지 수십~수백 개를 한 번에
 * 처리하는 동안엔 메인 스레드가 바빠서 실제 DOM 삽입이 10프레임(~166ms)을 넘기는 경우가
 * 흔했고, 그러면 마진 보정이 조용히 스킵되어 테마 기본 간격이 그대로 드러났다(못생긴 간격).
 * 반면 삭제/수정 후 재조정은 이미 화면에 떠 있던 메시지라 즉시 연결된 상태라 항상 성공
 * 했다 — 같은 병합인데 경로에 따라 다르게 보이던 원인.
 *
 * 이제는 프레임 횟수가 아니라 "실제로 연결됐는지"를 MutationObserver로 감시해서, 몇 프레임이
 * 걸리든 연결되는 즉시 정확한 값을 읽는다. 영구히 연결이 안 되는 비정상적인 경우에 대비해
 * SAFETY_TIMEOUT_MS만 안전장치로 둔다(정상 상황에서는 절대 도달하지 않아야 함).
 */
function applyMergedTopMargin(root, reason) {
  const SAFETY_TIMEOUT_MS = 5000;

  const measure = () => {
    const cs = getComputedStyle(root);
    const marginBottom = cs.marginBottom || "0px";
    root.style.marginTop = `-${marginBottom}`;
    ctpDebugLogMargin(root, reason, {
      marginBottom,
      marginTopApplied: root.style.marginTop,
      computedMarginTopAfter: getComputedStyle(root).marginTop,
      borderTopWidth: cs.borderTopWidth,
      classes: root.className
    });
  };

  if (root.isConnected) {
    measure();
    return;
  }

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    clearTimeout(safetyTimer);
    if (root.isConnected) measure();
    // 안전 타임아웃까지 연결이 안 됐다면(비정상 상황) 마진 보정만 조용히 포기한다.
  };

  const observer = new MutationObserver(() => {
    if (root.isConnected) finish();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const safetyTimer = setTimeout(finish, SAFETY_TIMEOUT_MS);
}

// ── 진단용 임시 로깅 (원인 확정되면 제거) ──────────────────────────────
// 같은 메시지가 서로 다른 경로(초기 렌더 vs 삭제/수정/생성 후 재조정)로 처리될 때
// 실제로 읽히는 marginBottom/marginTop 값이 다른지, 아니면 값은 같은데 다른 무언가
// (클래스, 테두리 등)가 달라지는지를 메시지 id별로 비교해서 콘솔에 보여준다.
// 값이 달라지면 자동으로 강조(warn)해서 바로 눈에 띄게 한다.
const ctpDebugMarginLog = new Map(); // messageId -> 마지막으로 기록된 결과
function ctpDebugLogMargin(root, reason, data) {
  const id = root.dataset.messageId || "(no-id)";
  const prev = ctpDebugMarginLog.get(id);
  const entry = { reason, ...data, at: performance.now().toFixed(1) };
  ctpDebugMarginLog.set(id, entry);
  if (prev && prev.marginBottom !== data.marginBottom) {
    console.warn("[CTP-DEBUG] 값 변경 감지!", { id, before: prev, after: entry });
  } else {
    console.log("[CTP-DEBUG]", id, entry);
  }
}
window.CTP_DEBUG_MARGIN_LOG = ctpDebugMarginLog;

/**
 * 채팅 로그에 다른 모듈(MRKB's Chat Enhancements 등)이 삽입하는
 * ".message-content > h4" 요소가 내용은 비어 있는데도 브라우저 기본 h4 여백을
 * 그대로 차지해서, 대사 위에 "엔터를 한 번 친 것처럼" 불필요한 빈 줄이 보이는
 * 문제가 있다. 우리 모듈 소속 요소가 아니라 직접 고칠 수 없으므로, 화면에서만
 * 여백을 접어버리는 방식으로 우회한다. 설정(collapseEmptyContentHeader)으로
 * 켜고 끌 수 있으며 기본값은 켜짐(여백 제거).
 */
function applyEmptyContentHeaderFix(root) {
  let shouldCollapse = true;
  try {
    shouldCollapse = game.settings.get(MODULE_ID, "collapseEmptyContentHeader");
  } catch (_err) {
    // 설정이 아직(또는 등록 실패로) 없으면 기본 동작(여백 제거)으로 폴백한다.
  }
  root.querySelectorAll(".message-content > h4").forEach((h4) => {
    const isEmpty = !(h4.textContent || "").trim();
    if (!isEmpty) return;
    if (shouldCollapse) {
      h4.style.margin = "0";
      h4.style.display = "none";
      h4.classList.add("ctp-empty-header-collapsed");
    } else {
      h4.style.removeProperty("margin");
      h4.style.removeProperty("display");
      h4.classList.remove("ctp-empty-header-collapsed");
    }
  });
}

/** 설정이 바뀌었을 때, 이미 그려진 채팅 로그(팝아웃 포함)의 빈 h4들을 즉시 다시 적용한다. */
function refreshAllEmptyContentHeaders() {
  document.querySelectorAll("li.chat-message").forEach((root) => applyEmptyContentHeaderFix(root));
}

/**
 * applyEmptyContentHeaderFix를 "지금 당장 한 번"이 아니라, 이 메시지 root의 DOM 변화를
 * 잠깐 지켜보면서 h4가 나타날 때마다 다시 적용한다.
 *
 * 배경: renderChatMessageHTML 훅은 같은 메시지에 대해 여러 모듈의 핸들러가 "등록된 순서대로"
 * 실행된다. 빈 h4를 실제로 삽입하는 다른 모듈(예: MRKB's Chat Enhancements)의 핸들러가 우리
 * 모듈보다 나중에 실행되거나, 그 모듈이 아예 비동기로(자체 렌더 완료 후) h4를 끼워넣는
 * 구조라면, renderChatPortrait 시점에 한 번만 querySelectorAll을 돌려서는 그 h4를 영원히
 * 놓친다 — 실제로 이 증상(셀렉터는 정확히 맞는데 100% 미적용)으로 확인됨.
 * MutationObserver로 짧게 감시하면 우리 훅보다 나중에 실행되는 핸들러든, 별도 비동기
 * 삽입이든 순서와 무관하게 잡아낼 수 있다. 메시지 DOM은 보통 금방 안정되므로 일정 시간 뒤
 * 감시를 끊어 옵저버가 무한정 쌓이지 않게 한다.
 */
function watchAndApplyEmptyContentHeaderFix(root) {
  applyEmptyContentHeaderFix(root); // 이미 h4가 있는 경우(대부분)는 바로 반영.

  const observer = new MutationObserver(() => applyEmptyContentHeaderFix(root));
  observer.observe(root, { childList: true, subtree: true });
  // 채팅 메시지 DOM은 렌더 직후 금방 안정되므로, 몇 초 뒤엔 감시를 끊는다.
  setTimeout(() => observer.disconnect(), 3000);
}

/**
 * 메시지 하나(root)의 초상화/병합(헤더 숨김·여백 상쇄) 표시를 처음부터 다시 계산해서 적용한다.
 * renderChatMessageHTML 최초 렌더뿐 아니라, 메시지 삭제/수정으로 인해 "직전 메시지가 누구인지"가
 * 바뀐 뒤 재조정할 때도 그대로 재사용할 수 있도록, 항상 먼저 이전에 붙여놨던 상태(숨긴 헤더,
 * 상쇄 마진, 삽입해둔 초상화 wrapper)를 전부 초기화한 뒤 현재 상황에 맞게 다시 판단한다.
 * 즉 몇 번을 다시 호출해도 항상 같은 결과가 나오는 멱등 함수다.
 */
function applyChatPortraitDisplay(message, root, reason = "unknown") {
  if (!root) return;

  // 초상화 대상 여부와 무관하게(귓속말 등도 포함) 항상 적용한다.
  watchAndApplyEmptyContentHeaderFix(root);

  // 이전에 이 메시지에 적용해뒀을 수 있는 병합/초상화 상태를 전부 되돌린다.
  // (삭제/수정으로 직전 메시지가 바뀌면 "병합→비병합" 또는 그 반대로도 바뀔 수 있어서
  // 매번 깨끗한 상태에서 다시 판단해야 한다.)
  const existingHeader = root.querySelector(".message-header");
  if (existingHeader) existingHeader.style.removeProperty("display");
  root.classList.remove("ctp-merged", "ctp-has-portrait");
  root.style.removeProperty("margin-top");
  root.querySelectorAll(".ctp-chat-portrait").forEach((wrapper) => wrapper.remove());

  const info = getChatPortraitInfo(message);
  if (!info) return; // 초상화 대상 아님 (귓속말/액터 없음/삭제된 액터)
  const { imgSrc, preset, mergeKey } = info;

  // 직전 메시지: DOM이 아니라 game.messages(문서 컬렉션) 순서를 기준으로 찾는다.
  // 컬렉션은 생성 순서(=화면에 표시되는 순서)대로 정렬되어 있다고 가정한다.
  // 메시지 삭제/수정 뒤 재조정할 때도 매번 이 시점의 최신 컬렉션을 다시 읽으므로,
  // "직전 메시지가 누구였는지"가 삭제로 바뀐 상황도 정확히 반영된다.
  //
  // [후속 버그 수정 - 문제 2] "직전"은 전체 메시지 기준이 아니라 "같은 채널" 기준이어야
  // 한다. 채널 버튼 전환 없이 그냥 바로 이전 인덱스만 보면, 그 사이(시간순)에 다른 채널의
  // 메시지가 하나라도 끼어 있을 때 엉뚱한 채널의 메시지와 병합 여부를 비교하게 되어(같은
  // 화자·같은 표정이어도 채널이 다르면 mergeKey가 갈려 병합이 깨짐) 병합이 어색하게 끊긴다.
  // 그래서 같은 채널의 메시지가 나올 때까지 뒤로 계속 탐색한다(범위 제한 없음 — 채팅 로그
  // 자체가 유한하고, 삭제/수정 시에만 도는 재조정이라 성능 부담도 거의 없다).
  const allMessages = game.messages.contents;
  const idx = allMessages.findIndex((m) => m.id === message.id);
  const myChannelId = getMessageChannelId(message);
  let prevMessage = null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (getMessageChannelId(allMessages[i]) === myChannelId) {
      prevMessage = allMessages[i];
      break;
    }
  }
  const prevInfo = prevMessage ? getChatPortraitInfo(prevMessage) : null;
  const canMerge = Boolean(prevInfo && prevInfo.mergeKey === mergeKey);

  if (canMerge) {
    // 이 메시지 고유의 이름/시간/초상화(헤더)만 숨기고, 본문(.message-content)은 그대로 둔다.
    // 우클릭 컨텍스트 메뉴 등 메시지 단위 조작은 <li> 전체 기준으로 동작하는 것이 Foundry
    // 기본 동작이라 헤더를 숨겨도 메시지 삭제 등 권한 동작 자체에는 영향이 없어야 한다.
    // (단, 헤더 안에 있는 개별 버튼형 UI가 있는 시스템/모듈이 있다면 그 버튼만 못 누르게
    // 될 수 있으니, 실제 사용 중인 시스템에서 한 번 확인해보는 걸 권장.)
    const header = root.querySelector(".message-header");
    if (header) header.style.display = "none";
    root.classList.add("ctp-merged");
    applyMergedTopMargin(root, reason);
    return;
  }

  const header = root.querySelector(".message-header") ?? root;
  const wrapper = document.createElement("div");
  wrapper.className = "ctp-chat-portrait";
  // 크기(px)/라운드니스는 [모듈 설정]의 GM 기본값(world)과 플레이어 개인 오버라이드
  // (client) 중 유효한 값을 getEffectiveChatPortraitDisplay()가 계산해서 돌려준다.
  // 설정 변경 시에는 refreshAllChatPortraitStyles()가 이미 그려진 wrapper들의 스타일을 즉시 갱신한다.
  const { size: displaySizePx, roundness: displayRoundness } = getEffectiveChatPortraitDisplay();
  Object.assign(wrapper.style, {
    ...getChatPortraitDisplayStyle(displaySizePx, displayRoundness),
    marginRight: "6px",
    overflow: "hidden",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    verticalAlign: "middle"
  });

  const img = document.createElement("img");
  img.src = imgSrc;
  img.alt = "";

  // 크롭/배경 계산은 main.js와 GMManagerApp.js 편집창 미리보기가 동일한 함수를 공유한다
  // (module-config.js#getChatPortraitCropStyle). 실사용 중 발견된 상하 이동 미적용 버그
  // 수정 이력은 그 함수의 주석 참고.
  const cropStyle = getChatPortraitCropStyle(preset);
  Object.assign(img.style, cropStyle.img);
  if (cropStyle.background !== "transparent") wrapper.style.backgroundColor = cropStyle.background; // 3.3, 없으면 투명 유지

  wrapper.append(img);
  header.prepend(wrapper);
  root.classList.add("ctp-has-portrait");
}

function renderChatPortrait(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  if (root.dataset.ctpProcessed === "1") return; // 멱등성 가드 (최초 렌더가 스크롤 등으로 중복 호출되는 것만 방지)
  root.dataset.ctpProcessed = "1";
  applyChatPortraitDisplay(message, root, "initial-render");
}

/**
 * 채팅 로그에서 메시지가 삭제되거나 수정되면, "누가 직전 메시지인지"가 바뀔 수 있어서
 * 그 주변 메시지들의 병합(헤더 숨김/여백 상쇄) 판단이 낡은 채로 남는다 — 실사용 중 확인된
 * 문제(중간 메시지를 지우면 레이아웃이 깨져 보임). renderChatPortrait은 메시지가 최초로
 * DOM에 그려질 때 한 번만 판단하고 멱등성 가드로 재계산을 막아버리기 때문에, 삭제/수정 뒤에는
 * 화면에 떠 있는 모든 채팅 메시지를 처음부터 다시 판단해서 바로잡는다. 삭제/수정은 자주
 * 일어나는 동작이 아니라서, 화면에 보이는 메시지 전체를 다시 훑어도 성능 부담은 거의 없다.
 * (팝아웃된 채팅 로그 창도 같은 문서 트리에 있으므로 document 전체를 대상으로 한다.)
 */
function refreshAllChatPortraitsAndMerges(reason = "refresh") {
  document.querySelectorAll("li.chat-message").forEach((root) => {
    const messageId = root.dataset.messageId;
    if (!messageId) return;
    const message = game.messages.get(messageId);
    if (!message) return; // 이미 삭제된 메시지 자신의 <li>는 Foundry가 알아서 지운다.
    try {
      applyChatPortraitDisplay(message, root, reason);
    } catch (err) {
      console.error(`${LOG_PREFIX} 채팅 메시지 재조정 중 오류:`, err);
    }
  });
}

/**
 * 채팅 초상화 크기/라운드니스의 "실제 적용값"을 계산한다.
 * chatPortraitSize/chatPortraitRoundness(둘 다 client 스코프) 값을 그대로 읽기만 한다.
 * 이 값이 GM 강제값인지, GM 기본값 + 개인 오버라이드인지, 순수 개인값인지는 Force Client
 * Settings 모듈이 자물쇠 상태에 따라 이 client 설정 자체를 어떻게 채워 넣는지에 달려 있고,
 * 그 판단은 이 모듈 밖에서 이뤄지므로 여기서는 신경 쓰지 않는다.
 *
 * overrides: 호출부가 방금 바뀐 값을 캐시 지연 없이 즉시 반영하고 싶을 때(예: onChange
 * 콜백) 넘기는 파라미터. { chatPortraitSize, chatPortraitRoundness } 중 일부만 넣으면 된다.
 */
function getEffectiveChatPortraitDisplay(overrides = {}) {
  const get = (key) => (key in overrides ? overrides[key] : game.settings.get(MODULE_ID, key));
  return {
    size: get("chatPortraitSize"),
    roundness: get("chatPortraitRoundness")
  };
}

/**
 * v1.7.32 이전 구조(GM 기본값 chatPortraitSize/Roundness(world) + 잠금 chatPortraitLocked(world) +
 * 개인 오버라이드 chatPortraitUseCustom/CustomSize/CustomRoundness(client))에서, 통합된
 * 단일 client 설정(chatPortraitSize/Roundness)으로 값을 1회 이전한다.
 *
 * 이전 설정들은 이번 버전에서 등록을 제거했기 때문에 game.settings.get()으로는 더 이상
 * 읽을 수 없다. 하지만 저장소 자체(월드 Setting 문서 / 클라이언트 localStorage)에는 값이
 * 그대로 남아 있으므로, 여기서는 그 원시 저장값을 직접 읽어 예전과 동일한 우선순위
 * (잠금 → 개인 사용 → GM 기본값)로 "지금까지 실제로 적용되고 있던 값"을 계산한 뒤 새
 * 설정에 써 넣는다. 이렇게 하면 마이그레이션 직후에도 화면에 보이는 크기/라운드니스가
 * 바뀌지 않는다. 클라이언트마다 개인 오버라이드 여부가 다를 수 있으므로 반드시 각
 * 클라이언트(플레이어 포함)에서 한 번씩 실행되어야 하며, chatPortraitMigrationV2Done
 * 플래그로 클라이언트당 정확히 1회만 실행되게 막는다(그렇지 않으면 마이그레이션 이후
 * 사용자가 새 설정을 직접 바꿔도 다음 접속 때 다시 예전 값으로 덮어써 버리게 된다).
 */
function readRawWorldSettingValue(key, fallback) {
  try {
    const fullKey = `${MODULE_ID}.${key}`;
    const worldStorage = game.settings.storage.get("world");
    const entry =
      typeof worldStorage?.find === "function"
        ? worldStorage.find((s) => s.key === fullKey)
        : (worldStorage?.getSetting?.(fullKey) ?? worldStorage?.get?.(fullKey));
    if (entry === undefined || entry === null) return fallback;
    const raw = entry.value !== undefined ? entry.value : entry;
    return raw === undefined || raw === null ? fallback : raw;
  } catch (err) {
    console.error(`${LOG_PREFIX} 마이그레이션: world 설정(${key}) 원시값 읽기 실패:`, err);
    return fallback;
  }
}

function readRawClientSettingValue(key, fallback) {
  try {
    const fullKey = `${MODULE_ID}.${key}`;
    const raw = localStorage.getItem(fullKey);
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_parseErr) {
      return raw; // 예전 버전이 순수 문자열로 저장했을 가능성에 대비한 폴백.
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} 마이그레이션: client 설정(${key}) 원시값 읽기 실패:`, err);
    return fallback;
  }
}

function migrateChatPortraitSettings() {
  try {
    if (game.settings.get(MODULE_ID, "chatPortraitMigrationV2Done")) return;
  } catch (err) {
    console.error(`${LOG_PREFIX} 마이그레이션 완료 플래그 확인 실패, 마이그레이션을 건너뜁니다:`, err);
    return;
  }

  try {
    const oldLocked = readRawWorldSettingValue("chatPortraitLocked", false);
    const oldGmSize = readRawWorldSettingValue("chatPortraitSize", DEFAULT_CHAT_PORTRAIT_SIZE);
    const oldGmRoundness = readRawWorldSettingValue("chatPortraitRoundness", DEFAULT_CHAT_PORTRAIT_ROUNDNESS);
    const oldUseCustom = readRawClientSettingValue("chatPortraitUseCustom", false);
    const oldCustomSize = readRawClientSettingValue("chatPortraitCustomSize", DEFAULT_CHAT_PORTRAIT_SIZE);
    const oldCustomRoundness = readRawClientSettingValue("chatPortraitCustomRoundness", DEFAULT_CHAT_PORTRAIT_ROUNDNESS);

    const effectiveUseCustom = !oldLocked && Boolean(oldUseCustom);
    const migratedSize = effectiveUseCustom ? oldCustomSize : oldGmSize;
    const migratedRoundness = effectiveUseCustom ? oldCustomRoundness : oldGmRoundness;

    Promise.resolve(game.settings.set(MODULE_ID, "chatPortraitSize", migratedSize)).catch((err) => {
      console.error(`${LOG_PREFIX} 마이그레이션: chatPortraitSize 저장 실패:`, err);
    });
    Promise.resolve(game.settings.set(MODULE_ID, "chatPortraitRoundness", migratedRoundness)).catch((err) => {
      console.error(`${LOG_PREFIX} 마이그레이션: chatPortraitRoundness 저장 실패:`, err);
    });

    console.log(
      `${LOG_PREFIX} 채팅 초상화 설정을 통합 설정으로 마이그레이션했습니다. ` +
        `size=${migratedSize}, roundness=${migratedRoundness} (개인 오버라이드 적용: ${effectiveUseCustom})`
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} 채팅 초상화 설정 마이그레이션 실패:`, err);
  } finally {
    Promise.resolve(game.settings.set(MODULE_ID, "chatPortraitMigrationV2Done", true)).catch((err) => {
      console.error(`${LOG_PREFIX} 마이그레이션 완료 플래그 저장 실패:`, err);
    });
  }
}

/**
 * [모듈 설정]의 채팅 초상화 관련 값이 바뀌었을 때, 채팅 로그를 새로고침하지
 * 않고도 이미 그려진 초상화(.ctp-chat-portrait)들의 인라인 스타일만 즉시 갱신한다.
 * (팝아웃된 채팅 로그 창도 같은 문서 트리에 있으므로 document 전체를 대상으로 한다.)
 */
function refreshAllChatPortraitStyles(overrides = {}) {
  try {
    const { size: displaySizePx, roundness: displayRoundness } = getEffectiveChatPortraitDisplay(overrides);
    const displayStyle = getChatPortraitDisplayStyle(displaySizePx, displayRoundness);
    document.querySelectorAll(".ctp-chat-portrait").forEach((wrapper) => {
      Object.assign(wrapper.style, displayStyle);
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} 채팅 초상화 크기/라운드니스 갱신 실패:`, err);
  }
}

/**
 * GM 매니저는 무거운 ApplicationV2/DialogV2 API를 쓰기 때문에,
 * 혹시 그 파일에 문제가 있어도 본 모듈(채팅 명령/소켓/스탠딩 표시)이
 * 전부 죽지 않도록 "필요할 때만" 지연 로드합니다.
 */
async function openManagerSafely(actorId = null) {
  try {
    const { TheatreGMManager } = await import("./GMManagerApp.js");
    TheatreGMManager.open(actorId);
  } catch (err) {
    console.error(`${LOG_PREFIX} 매니저 창 로드 실패:`, err);
    ui.notifications.error("무대 매니저 창을 여는 중 오류가 발생했습니다. 콘솔(F12)을 확인해주세요.");
  }
}

/**
 * [표정 선택 도우미] GM 매니저와 마찬가지로, 혹시 이 파일에 문제가 있어도 본 모듈
 * 전체(채팅 명령/소켓/스탠딩 표시)가 죽지 않도록 지연 로드로 격리한다.
 */
async function openExpressionPickerSafely() {
  try {
    const { TheatreExpressionPicker } = await import("./ExpressionPickerWidget.js");
    TheatreExpressionPicker.ensureOpen();
  } catch (err) {
    console.error(`${LOG_PREFIX} 표정 선택 도우미 로드 실패:`, err);
    ui.notifications.error("표정 선택 도우미를 여는 중 오류가 발생했습니다. 콘솔(F12)을 확인해주세요.");
  }
}

/** [표정 선택 도우미] ready 시점에 이전 열림/닫힘 상태를 복원(기본값: 열림)한다. */
async function restoreExpressionPickerSafely() {
  try {
    const { TheatreExpressionPicker } = await import("./ExpressionPickerWidget.js");
    TheatreExpressionPicker.restore();
  } catch (err) {
    console.error(`${LOG_PREFIX} 표정 선택 도우미 상태 복원 실패:`, err);
  }
}

Hooks.once("init", () => {
  console.log(`${LOG_PREFIX} Initializing module...`);

  // 상태 지속성(persistence): 새로고침/재접속한 플레이어도 현재 무대 상태를 보게 하기 위해
  // world 스코프 세팅에 마지막 상태를 저장해둔다. (쓰기는 GM 클라이언트에서만 발생)
  // [Phase 4] 채널ID → 상태({slots, text, speakerName, speakerActorId, speakerAppearance,
  // updatedAt}) 맵. 옛 버전(단일 평면 객체)이 저장돼 있으면 TheatreApp.js/module-config.js의
  // migrateChannelStateMap()이 읽는 시점마다 자동으로 새 맵 형태로 감싸 처리한다(하위 호환).
  game.settings.register(MODULE_ID, "currentState", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  // [Phase 4, 3-5 결정] 슬롯 잠금(lockedSlots)은 채널과 무관한 전역 값이라 currentState
  // 맵과 별도로 저장한다(화면 레이아웃 개념 — "1번 자리는 잠긴다" 같은 물리적 배치).
  game.settings.register(MODULE_ID, "lockedSlots", {
    scope: "world",
    config: false,
    type: Array,
    default: [false, false, false, false]
  });

  // ── 채팅 초상화 크기/라운드니스 (모듈 설정 화면) ─────────────────────
  // GM 매니저 UI가 아니라 Foundry 기본 [설정 > 모듈 설정]에 노출되는 별도 항목이다.
  //
  // 기능당 실제 값 설정은 하나만 둔다(client 스코프). GM 기본값 강제/기본값 제공/
  // 개인 자유 설정의 3단계 적용 범위는 이 모듈이 자체 구현하지 않고, Force Client
  // Settings 모듈이 이 설정 항목 옆에 붙여주는 자물쇠 아이콘으로 결정한다:
  //   🔒 잠금        — GM이 설정한 값을 모든 플레이어에게 강제 적용(변경 불가)
  //   🔓 기본값 사용  — GM이 설정한 값이 기본값이 되며, 플레이어가 자신의 화면에서 덮어쓸 수 있음
  //   🔓 개인 설정    — 각 플레이어가 GM 값과 무관하게 자신의 값을 직접 설정
  // 실제 적용값 읽기는 getEffectiveChatPortraitDisplay() 참고(이제는 이 client 설정을
  // 그대로 읽기만 한다). v1.7.32 이전의 GM 기본값/개인 오버라이드/잠금 3중 설정은
  // migrateChatPortraitSettings()가 이 설정으로 1회 이전한다.
  //
  // 두 설정 모두 range(슬라이더)를 쓰지 않고 숫자를 직접 입력하는 형태로 통일했다.
  // Force Client Settings가 슬라이더형 입력에는 자물쇠 아이콘을 붙여주지 못해
  // (실사용 중 확인됨) 라운드니스도 크기와 동일하게 일반 숫자 입력으로 등록한다.

  game.settings.register(MODULE_ID, "chatPortraitSize", {
    name: "채팅 초상화 크기 (px)",
    hint: "채팅 로그 초상화의 가로/세로 크기(px)입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: DEFAULT_CHAT_PORTRAIT_SIZE,
    onChange: () => refreshAllChatPortraitStyles()
  });

  // 0 = 사각형(기본), 1 = 완전한 원. Force Client Settings의 자물쇠 아이콘이 붙도록
  // range(슬라이더)는 쓰지 않고 chatPortraitSize와 동일하게 숫자 직접 입력으로 둔다.
  game.settings.register(MODULE_ID, "chatPortraitRoundness", {
    name: "채팅 초상화 라운드니스",
    hint: "0이면 사각형, 1이면 완전한 원형입니다(0~1 사이 숫자, 예: 0.3).",
    scope: "client",
    config: true,
    type: Number,
    default: DEFAULT_CHAT_PORTRAIT_ROUNDNESS,
    onChange: () => refreshAllChatPortraitStyles()
  });

  // 마이그레이션이 이미 끝난 클라이언트인지 표시하는 내부 플래그. 설정 화면에는 노출하지
  // 않으며(config: false), migrateChatPortraitSettings()가 다시 실행되어 사용자가 새
  // 통합 설정을 바꾼 뒤에도 예전 값으로 덮어써버리는 일이 없도록 1회만 동작하게 막는다.
  game.settings.register(MODULE_ID, "chatPortraitMigrationV2Done", {
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  // 다른 모듈이 채팅 본문에 남기는 빈 h4(이름 표시용, 내용 없음)가 불필요한
  // 여백을 차지하는 문제를 화면에서만 우회 수정하는 기능. 클라이언트별로 각자
  // 켜고 끌 수 있게 client 스코프로 둔다.
  // (방어적으로 try/catch: 이 등록 하나가 실패해도 나머지 초기화가 전부 멈추지
  // 않도록 감싼다.)
  // 무대 HUD가 다른 Foundry UI(예: 스페이스 일시정지 아이콘)보다 앞에 뜨는 문제를
  // 사용자가 직접 조절할 수 있게 하는 설정. 화면마다 다르게 두고 싶을 수 있어
  // client 스코프로 둔다("top" = 기존 동작 유지, "behind" = 다른 UI보다 뒤로,
  // 단 맵시트/타일 등 캔버스 콘텐츠보다는 항상 앞).
  try {
    game.settings.register(MODULE_ID, "hudLayerMode", {
      name: "무대 HUD 앞뒤 배치",
      hint: "'항상 최상단'은 기존 동작(다른 UI보다도 위)입니다. '다른 UI보다 뒤로'를 선택하면 맵시트/타일보다는 앞이되, 사이드바나 일시정지 아이콘 같은 다른 화면 UI보다는 뒤로 이동합니다.",
      scope: "client",
      config: true,
      type: String,
      choices: {
        top: "항상 최상단 (기존 동작)",
        behind: "다른 UI보다 뒤로"
      },
      default: "top",
      onChange: () => theatreApp?._applyHudLayerSetting()
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} hudLayerMode 설정 등록 실패:`, err);
  }

  try {
    game.settings.register(MODULE_ID, "collapseEmptyContentHeader", {
      name: "빈 채팅 이름표시 여백 제거",
      hint: "다른 모듈이 채팅 내용 위에 남기는, 내용 없는 이름 표시용 빈 줄의 여백을 화면에서 제거합니다. 대사 위에 불필요한 빈 줄처럼 보이는 문제를 해결합니다.",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
      onChange: () => refreshAllEmptyContentHeaders()
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} collapseEmptyContentHeader 설정 등록 실패:`, err);
  }

  // ── [Phase 3] 스탠딩 박스 채널 버튼 ────────────────────────────────────
  // custom-chat-channels가 없는 환경에서도 설정 등록 자체는 항상 해둔다(값이 그냥
  // 안 쓰일 뿐 오류는 나지 않아야 함). 실제 UI 노출 여부는 getChatChannelsApi()로 판단.
  try {
    // GM이 스탠딩 버튼에 노출할 채널을 최대 3개까지 고른 목록. 채널 자체의 존재/이름은
    // custom-chat-channels 쪽 world 설정을 그대로 신뢰하고, 여기서는 id 목록만 들고 있는다.
    // [v1.8.10] 기본값을 빈 배열([])에서 슬롯1=[메인]으로 바꿨다. 예전 기본값은 모듈을
    // 새로 설치했을 때 스탠딩 버튼 슬롯이 전부 비어 있어, 채널 연동 없이도 정상 동작하는
    // 기본(메인 채팅 자동 감지) 상태인데도 마치 아무 채널도 안 잡혀 오작동하는 것처럼
    // 보이는 문제가 있었다. 이 기본값은 world 설정이 한 번도 저장된 적 없는 "완전 새
    // 설치"에만 적용되며(이미 값이 저장된 기존 world는 영향 없음), GM은 스탠딩 채널
    // 설정창에서 언제든 자유롭게 바꿀 수 있다.
    game.settings.register(MODULE_ID, "standingEligibleChannels", {
      scope: "world",
      config: false,
      type: Array,
      default: [STANDING_MAIN_CHANNEL_ID, "", ""]
    });

    // 이 클라이언트가 스탠딩 박스 버튼으로 "지금 튜닝 중"인 채널. 빈 문자열이면 채널 연동
    // 없이 기존 동작(공개 채팅만 자동 감지)과 동일하다. custom-chat-channels의
    // activeChannelId(탭 전환)와는 별개 값이다 — 채팅 탭은 자유롭게 넘나들어도, 스탠딩
    // 박스에 표시할 대사만 이 값으로 고정해 필터링한다.
    game.settings.register(MODULE_ID, "myStandingChannel", {
      scope: "client",
      config: false,
      type: String,
      default: ""
    });

    // GM이 더블클릭으로 전원을 강제 전환시킨 채널. 빈 문자열이면 강제 중이 아님.
    // world 설정이라 접속이 늦은 클라이언트도 이 값을 읽어 뒤늦게 따라잡을 수 있다
    // (소켓 브로드캐스트는 이미 접속해 있는 클라이언트에 대한 즉시 반영용).
    game.settings.register(MODULE_ID, "forcedChannelId", {
      scope: "world",
      config: false,
      type: String,
      default: ""
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} 스탠딩 채널 설정 등록 실패:`, err);
  }

  try {
    const loadTemplatesFn = getLoadTemplatesFn();
    loadTemplatesFn([
      `modules/${MODULE_ID}/src/templates/theatre.html`,
      `modules/${MODULE_ID}/src/templates/gm-manager.html`
    ]);

    Handlebars.registerHelper("eq", (a, b) => a === b);
    Handlebars.registerHelper("math", (a, op, b) => {
      a = Number(a);
      b = Number(b);
      switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        default: return a;
      }
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} init 단계 템플릿/헬퍼 등록 실패:`, err);
  }

  // ── 채팅 초상화: 채팅 로그 렌더링 시점에 초상화 DOM 삽입 ──────────────
  // 반드시 init 단계에서 등록해야 한다. 사이드바 채팅로그의 "과거 메시지" 초기 렌더는
  // Foundry UI 초기화 과정에서 ready 훅이 발동되기 전에 이미 끝나기 때문에, 여기 등록을
  // ready로 미루면 새로고침 시 과거 로그에는 초상화가 전혀 안 붙는 문제가 생긴다
  // (세션 중 새로 도착하는 메시지에만 뒤늦게 반영됨). renderChatPortrait은 game.actors,
  // MODULE_ID만 참조하고 theatreApp 인스턴스에 의존하지 않으므로 이 시점에 등록해도 안전하다.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      renderChatPortrait(message, html);
    } catch (err) {
      console.error(`${LOG_PREFIX} 채팅 초상화 렌더링 중 오류:`, err);
    }
  });

  // 메시지가 삭제되거나 수정되면 "직전 메시지가 누구인지"가 바뀔 수 있어 주변 메시지의
  // 병합(헤더 숨김/여백 상쇄) 판단이 낡은 채로 남는다 — 화면에 떠 있는 채팅 전체를
  // 다시 조정한다. deleteChatMessage/updateChatMessage도 game.actors 등만 참조하고
  // theatreApp 인스턴스에 의존하지 않으므로 init 단계에서 등록해도 안전하다.
  Hooks.on("deleteChatMessage", () => {
    try {
      refreshAllChatPortraitsAndMerges("refresh:delete");
    } catch (err) {
      console.error(`${LOG_PREFIX} 메시지 삭제 후 채팅 레이아웃 재조정 중 오류:`, err);
    }
  });

  Hooks.on("updateChatMessage", () => {
    try {
      refreshAllChatPortraitsAndMerges("refresh:update");
    } catch (err) {
      console.error(`${LOG_PREFIX} 메시지 수정 후 채팅 레이아웃 재조정 중 오류:`, err);
    }
  });

  // 멀티플레이어 환경에서 여러 유저가 거의 동시에 메시지를 보내면, 소켓 수신 순서가
  // 클라이언트마다 달라 game.messages.contents의 로컬 순서가 실제(서버) 순서와 잠시
  // 어긋날 수 있다. 이 상태에서 renderChatMessageHTML이 먼저 도착한 메시지를 처리하면
  // "직전 메시지"를 잘못 판단해 병합 상태가 틀리게 굳어지고(ctpProcessed 가드 때문에
  // 다시 계산되지 않음), 나중에 뒤늦게 도착한 메시지 쪽에서만 정상 처리되어 화면이
  // 깨진 채로 남는다 — 실사용 중 확인된 문제(오래된 채팅에서 병합 표시가 깨짐, 새로고침
  // 하면 고쳐짐). 새 메시지가 도착할 때마다 화면 전체를 재조정해서, 그 시점엔 이미
  // game.messages.contents에 새 메시지가 반영돼 있으므로 앞서 잘못 굳어진 메시지도
  // 함께 바로잡는다. delete/update와 동일한 패턴이며 applyChatPortraitDisplay가
  // 멱등 함수라 여러 번 다시 불러도 안전하다.
  Hooks.on("createChatMessage", () => {
    try {
      refreshAllChatPortraitsAndMerges("refresh:create");
    } catch (err) {
      console.error(`${LOG_PREFIX} 메시지 생성 후 채팅 레이아웃 재조정 중 오류:`, err);
    }
  });

  // ── 채팅 명령 & @표정태그 가로채기 (전부 취소 가능한 pre-hook) ──────────
  Hooks.on("chatMessage", (chatLog, messageText) => {
    if (!theatreApp) return;

    try {
      // [Phase 4, 3-3/3-4 결정] @태그/명령이 "지금 어느 채널 것인지"는 스탠딩 튜닝 채널
      // (myStandingChannel)이 아니라, 지금 이 사람이 채팅창에서 보고 있는 활성 탭
      // (activeChannelId)을 기준으로 삼는다. custom-chat-channels가 없거나 비활성이면
      // 항상 메인 채널로 취급한다(기존 동작과 동일). [표정 선택 도우미] 이 계산은
      // ExpressionPickerWidget.js와도 공유해야 하므로 module-config.js의 공용
      // getActiveStandingChannelId()로 뺐다.
      const activeChannelId = getActiveStandingChannelId();

      if (messageText.startsWith("/theatre-clear")) {
        if (!game.user.isGM) {
          ui.notifications.warn("전체 초기화는 GM만 사용할 수 있습니다.");
          return false;
        }
        theatreApp.clearAll(activeChannelId);
        return false;
      }

      if (messageText.startsWith("/theatre-manager")) {
        openManagerSafely();
        return false;
      }

      if (messageText.startsWith("/theatre ")) {
        const text = messageText.replace("/theatre ", "").trim();
        const slots = theatreApp._getWorkingSlotsForChannel(activeChannelId);
        theatreApp.updateAndBroadcast(slots, text, undefined, undefined, undefined, theatreApp.lockedSlots, activeChannelId);
        return false;
      }

      // @퇴장 커맨드: 무대 텍스트 스탠딩 박스 한정 기능. "@퇴장" 뒤에 어떤 텍스트가
      // 붙어도(있든 없든) 전부 무시하고, 현재 선택중인(=화자인) 액터의 스탠딩을
      // 슬롯 '비우기'(clearSlot)와 완전히 동일한 로직으로 스탠딩 박스에서 제거한다.
      // 아래 @표정 태그와 동일하게 뒤 텍스트는 채팅창에 남기지 않고 그대로 버린다.
      // "@퇴장"으로 시작하고 그 다음이 공백이거나 끝인 경우에만 매치(예: "@퇴장모드"처럼
      // 퇴장으로 시작하는 다른 태그 이름과는 섞이지 않도록).
      if (/^@퇴장(?:\s|$)/.test(messageText)) {
        const speaker = ChatMessage.getSpeaker();
        const actor = speaker?.actor ? game.actors.get(speaker.actor) : null;
        if (actor) {
          const exited = theatreApp.exitActorFromStanding(actor.id, activeChannelId);
          if (!exited) ui.notifications.warn(`${actor.name}은(는) 현재 무대에 없습니다.`);
        }
        return false; // 채팅창/대사창 원문에는 명령이 노출되지 않도록 소비
      }

      // @표정 태그: "@웃음", "@슬픔 대사..." 형태.
      // 등록된 표정과 일치할 때만 소비(=채팅창에 남기지 않음). 일치 안 하면 일반 채팅으로 흘려보냄.
      const tagMatch = messageText.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
      if (tagMatch) {
        const [, tag, rest] = tagMatch;
        const speaker = ChatMessage.getSpeaker();
        const actor = speaker?.actor ? game.actors.get(speaker.actor) : null;

        if (actor) {
          const expressions = actor.getFlag(MODULE_ID, "expressions") ?? [];
          const found = expressions.find((e) => e.name === tag);

          if (found) {
            const restTrimmed = rest?.trim() || null;
            // [표정 오염 수정] "이 채널(activeChannelId)에서 마지막으로 지정된 표정"으로
            // 채널별 저장소에 기록한다 — 스탠딩 박스(가지 B)와 채팅 초상화가 이 값을 함께 쓴다.
            // 예전에는 채널 구분 없이 전역 플래그 하나에 덮어써서, 여기서 태그를 바꾸면
            // 지금 보고 있는 채널과 무관하게 다른 채널의 표정/초상화까지 같이 바뀌어버렸다.
            setLastExpressionForChannel(actor, activeChannelId, found.img).catch((err) => {
              console.error(`${LOG_PREFIX} 채팅 초상화 표정 플래그 갱신 실패:`, err);
            });
            if (restTrimmed) theatreApp.speakAs(actor, restTrimmed, found.img, { emit: true, channelId: activeChannelId });
            else theatreApp.changeExpressionOnly(actor, found.img, { emit: true, channelId: activeChannelId });
            return false; // 채팅창/대사창 원문에는 태그가 노출되지 않도록 명령으로만 소비
          }
        }
        // 매칭되는 표정이 없으면 일반 채팅으로 그대로 통과시킴 (return 하지 않음)
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} chatMessage 처리 중 오류:`, err);
    }
  });
});

Hooks.once("ready", () => {
  try {
    migrateChatPortraitSettings();

    theatreApp = new TheatreApp();
    theatreApp.restorePersistedState();
    restoreExpressionPickerSafely();

    game.socket.on(SOCKET_NAME, (data) => {
      if (data.type === "UPDATE_THEATRE") {
        theatreApp.renderWithData(data.payload);
      }
      // [Phase 4] 플레이어 클라이언트는 world 설정에 직접 쓸 수 없어, GM에게 "이 채널의
      // 상태를 저장해달라"고 요청한다(구 REQUEST_PERSIST_STATE를 채널 스코프로 대체).
      if (data.type === "REQUEST_PERSIST_CHANNEL_STATE" && game.user.isGM) {
        const { channelId, entry } = data.payload || {};
        if (!channelId || !Array.isArray(entry?.slots) || entry.slots.length !== 4) return;
        try {
          const raw = game.settings.get(MODULE_ID, "currentState");
          // [버그 수정] migrateChannelStateMap이 이미 맵 형태면 원본 참조를 그대로 돌려주므로,
          // 여기서 얕은 복사한 새 맵 객체에 대입해야 world 설정 캐시 원본을 직접 mutate하지 않는다.
          const map = { ...migrateChannelStateMap(raw) };
          // [CT-FIX] 이미 이 채널에 더 최신 상태가 저장돼 있다면(도착 순서가 뒤집힌 오래된
          // 요청), 덮어쓰지 않고 무시한다 — 기존 isStateStale 가드와 동일한 취지.
          const existing = map[channelId];
          if (existing && typeof existing.updatedAt === "number" && typeof entry.updatedAt === "number" && entry.updatedAt < existing.updatedAt) {
            return;
          }
          // [CT-FIX v1.8.8][문제 1: 간헐적 기본 표정 리셋 근본 수정] 위 시간 가드는 "같거나
          // 더 최신"인 요청을 걸러내지 못한다(동률/얼어붙은 updatedAt 포함). 그래서 시간
          // 가드를 통과했더라도, 이 요청이 slotsAuthoritative=false(단순 대사 갱신이라
          // 슬롯 내용은 안 바뀌어야 정상)라면 슬롯만큼은 이미 저장된 값을 그대로 지켜서,
          // 다른 클라이언트가 방금 확정한 더 새 표정을 되돌리지 못하게 한다.
          const finalSlots = (entry.slotsAuthoritative === false && Array.isArray(existing?.slots))
            ? existing.slots
            : entry.slots;
          map[channelId] = {
            slots: finalSlots,
            text: entry.text || "",
            speakerName: entry.speakerName || "",
            speakerActorId: entry.speakerActorId || null,
            speakerAppearance: entry.speakerAppearance || {},
            updatedAt: entry.updatedAt
          };
          const eligible = normalizeStandingEligibleChannels(game.settings.get(MODULE_ID, "standingEligibleChannels"));
          game.settings.set(MODULE_ID, "currentState", pruneChannelStateMap(map, eligible)).catch((err) => {
            console.error(`${LOG_PREFIX} 플레이어 요청 채널 상태 저장 실패:`, err);
          });
        } catch (err) {
          console.error(`${LOG_PREFIX} 플레이어 요청 채널 상태 저장 실패:`, err);
        }
      }
      // [Phase 4] 슬롯 잠금(전역 값) 저장 요청 — 플레이어는 world 설정에 직접 쓸 수 없다.
      if (data.type === "REQUEST_PERSIST_LOCKED_SLOTS" && game.user.isGM) {
        const lockedSlots = data.payload?.lockedSlots;
        if (Array.isArray(lockedSlots) && lockedSlots.length === 4) {
          game.settings.set(MODULE_ID, "lockedSlots", lockedSlots).catch((err) => {
            console.error(`${LOG_PREFIX} 플레이어 요청 슬롯 잠금 저장 실패:`, err);
          });
        }
      }
      // [Phase 3] GM이 스탠딩 채널 버튼을 더블클릭해 전원 강제 전환/해제할 때, world
      // 설정(forcedChannelId) 저장 후의 updateSetting 훅을 기다리지 않고 즉시 반영한다.
      // (동일한 결과를 updateSetting 핸들러도 안전망으로 한 번 더 처리하므로, 이 소켓을
      // 놓친 클라이언트도 결국 같은 상태에 도달한다.)
      if (data.type === "FORCE_STANDING_CHANNEL") {
        applyForcedStandingChannel(data.payload?.channelId ?? "");
      }
    });

    // 소켓 UPDATE_THEATRE 수신을 놓친 클라이언트도 world 설정 갱신을 통해
    // 즉시 같은 상태를 그린다. 플레이어가 바꾼 상태는 GM이 위 요청을 받아
    // currentState에 저장하며, Setting 문서 갱신은 모든 접속자에게 동기화된다.
    Hooks.on("updateSetting", (setting) => {
      if (setting.key === `${MODULE_ID}.currentState`) {
        // updateSetting 훅 시점에는 game.settings 캐시가 이전 값을 가리킬 수 있으므로,
        // 이벤트 문서에 포함된 최신 값을 직접 사용한다.
        // [Phase 4] 이제 이 값은 "채널ID → 상태" 맵이다. 이 클라이언트가 튜닝 중인 채널의
        // 항목만 꺼내 renderWithData에 넘긴다 — 다른 채널 항목이 바뀐 것이라면
        // renderWithData 내부의 channelId 필터에서 자연히 무시된다(굳이 여기서 다시
        // 걸러낼 필요는 없지만, 없는 채널일 때 빈 항목을 만들지 않도록 존재 여부만 확인).
        const map = migrateChannelStateMap(setting.value);
        const myChannel = game.settings.get(MODULE_ID, "myStandingChannel") || STANDING_MAIN_CHANNEL_ID;
        const entry = map[myChannel];
        if (!entry || !Array.isArray(entry.slots) || entry.slots.length !== 4) return;
        // [버그 수정] entry.slots는 world 설정 캐시가 들고 있는 원본 배열일 수 있으므로,
        // this.slots가 그 배열을 그대로 가리키게 되지 않도록 여기서도 복사해서 넘긴다.
        theatreApp.renderWithData({
          ...entry,
          slots: entry.slots.map((slot) => (slot ? { ...slot } : null)),
          channelId: myChannel,
          lockedSlots: theatreApp.lockedSlots
        }).catch((err) => {
          console.error(`${LOG_PREFIX} 저장 상태 실시간 동기화 실패:`, err);
        });
      }
      // [Phase 4] 슬롯 잠금(전역 값)이 바뀌면 모든 클라이언트가 즉시 반영한다.
      if (setting.key === `${MODULE_ID}.lockedSlots`) {
        const nextLocked = Array.isArray(setting.value) ? setting.value : [false, false, false, false];
        theatreApp.renderWithData({
          channelId: theatreApp.currentChannelId,
          slots: theatreApp.slots,
          text: theatreApp.currentText,
          speakerName: theatreApp.currentSpeakerName,
          speakerActorId: theatreApp.currentSpeakerActorId,
          speakerAppearance: theatreApp.currentSpeakerAppearance,
          lockedSlots: nextLocked,
          updatedAt: theatreApp._getLastAppliedUpdatedAt(theatreApp.currentChannelId)
        }).catch((err) => {
          console.error(`${LOG_PREFIX} 슬롯 잠금 실시간 동기화 실패:`, err);
        });
      }
      // 채팅 초상화 크기/라운드니스는 이제 client 스코프 단일 설정이라 world Setting
      // 문서로 동기화되지 않는다. 각자의 화면 갱신은 해당 설정의 onChange(로컬 변경) 또는
      // Force Client Settings가 값을 밀어넣을 때 함께 발생하는 로컬 onChange로 처리된다.

      // [Phase 3] 소켓(FORCE_STANDING_CHANNEL)을 놓친 클라이언트(재접속 등)를 위한 안전망.
      // 최종적으로 world 설정 값과 항상 같은 결과에 도달하도록, 소켓과 동일한 함수를 재사용한다.
      if (setting.key === `${MODULE_ID}.forcedChannelId`) {
        applyForcedStandingChannel(setting.value ?? "");
      }
      // GM이 스탠딩 채널 설정창에서 노출 채널 목록을 바꾸면 모든 클라이언트의 버튼 바를 갱신한다.
      if (setting.key === `${MODULE_ID}.standingEligibleChannels`) {
        theatreApp?.render();
      }
    });

    // 액터 공용 외형(이름 색·스탠딩 배율) Flag가 바뀌면 각 접속자의 HUD도
    // 즉시 다시 그린다. 여기서는 소켓을 재전송하지 않아 갱신 루프가 생기지 않는다.
    Hooks.on("updateActor", (actor, changes) => {
      if (changes.flags?.[MODULE_ID]?.appearance === undefined) return;
      theatreApp.refreshActorAppearance(actor, { broadcast: false }).catch((err) => {
        console.error(`${LOG_PREFIX} 액터 외형 즉시 갱신 실패:`, err);
      });
    });

    // ── 일반 채팅 자동 감지: 캐릭터로 말하면 자동으로 대사창(+등록된 표정 있으면 스탠딩) 표시 ──
    // ChatMessage 문서는 생성되면 모든 클라이언트에 동일하게 동기화되므로,
    // 여기서는 소켓 브로드캐스트 없이 각자 로컬에서 동일한 로직을 수행합니다.
    Hooks.on("createChatMessage", (message) => {
      try {
        const text = getTheatreChatText(message);
        if (!text || text.startsWith("@")) return; // @태그 메시지는 이미 위에서 처리(또는 일반문구 그대로 스킵)

        // GM 전용 귓속말(whisper)은 무대 HUD처럼 모두에게 보이는 화면에는 반영하지 않음
        if (message.whisper?.length) return;

        const actorId = message.speaker?.actor;
        if (actorId) {
          const actor = game.actors.get(actorId);
          if (actor) {
            // 토큰/액터는 연결돼 있지만(초상화 매칭용) 화자 표시 이름(alias)이 그
            // 액터의 실제 이름과 다르게 지정된 경우(예: 하나의 토큰으로 여러 NPC를
            // 말하는 매크로) — 스탠딩 박스 이름표도 채팅 로그와 동일하게 그 alias를
            // 쓰도록 넘긴다. alias가 없거나 actor.name과 같으면 기존과 동일하게 동작.
            const alias = message.speaker?.alias?.trim() || "";
            const displayName = alias && alias !== actor.name ? alias : null;
            // [Phase 4] 이 훅은 whisper가 없는(=custom-chat-channels 채널이 아닌) 메시지에서만
            // 발동하므로(위 whisper 스킵), 항상 메인 채널 소속으로 취급한다. 지금 다른 채널을
            // 튜닝 중이면(currentChannelId !== 메인) speakAs 내부에서 화면은 건드리지 않고
            // 메인 채널의 저장값만 갱신한다 — 이전에는 이 구분이 없어 다른 채널을 보고 있어도
            // 메인 채팅이 화면에 새어 들어왔다(Phase 4가 고치는 누수 중 하나).
            theatreApp.speakAs(actor, text, null, { emit: false, displayName, channelId: STANDING_MAIN_CHANNEL_ID });
            return;
          }
        }

        // 액터에 연결되지 않은 화자 처리 (나레이터 툴, NPC 대사 매크로, 판정 매크로 등).
        // speaker.alias가 있으면 그 이름을 이름표로 표시하고, 없거나 빈 문자열이면
        // 이름표 없이 텍스트만 표시한다 (예: 순수 서술/판정 안내 메시지).
        const alias = message.speaker?.alias?.trim() || "";
        theatreApp.speakAsAlias(alias, text, { emit: false, channelId: STANDING_MAIN_CHANNEL_ID });
      } catch (err) {
        console.error(`${LOG_PREFIX} createChatMessage 처리 중 오류:`, err);
      }
    });

    // ── 채팅 초상화: 메시지 생성 시점에 표정 스냅샷을 플래그로 고정 ──────────
    // 기존 자동 대사 감지용 createChatMessage 훅(귓속말 스킵 로직 포함)과는
    // 물리적으로 다른 콜백으로 완전히 분리하고, 귓속말 스킵도 별도로 다시 검사한다.
    Hooks.on("preCreateChatMessage", (message, data) => {
      try {
        // 중요(원인 확정, v1.7.16 디버깅으로 발견): 채팅창에 직접 입력해 전송하는
        // 일반적인 메시지는 Foundry가 화자(speaker)를 스키마 기본값(ChatMessage.getSpeaker())으로
        // 채워 넣는데, 이 기본값은 preCreateChatMessage 훅이 실행된 "이후"에 반영된다.
        // 즉 훅에 넘어오는 원본 입력값 data.speaker는 이 시점에 비어 있을 수 있다(실사용 중 확인됨).
        // 반면 message(문서 인스턴스) 쪽은 이미 기본값까지 반영되어 있으므로 반드시 message.speaker를
        // 읽어야 한다. data.whisper도 같은 이유로 message.whisper를 함께 사용한다.
        // 귓속말 메시지는 지원 범위 제외 (3.1). 단, custom-chat-channels의 channelId flag가
        // 있는 채널 메시지는 예외로 통과시킨다 (1-C 승인 사항, v1.7.35). 이 예외는 이 훅과
        // 위 getChatPortraitInfo 두 지점에만 적용하며, 아래 별도의 createChatMessage
        // 자동 대사 감지 훅(라인 851 부근)의 whisper 스킵은 손대지 않는다.
        if (message.whisper?.length && !isChatChannelsMessage(message)) return;

        const actorId = message.speaker?.actor;
        if (!actorId) return; // 나레이터/별칭 메시지는 액터가 없어 구조상 자동 제외

        const actor = game.actors.get(actorId);
        if (!actor) return;

        // [표정 오염 수정] 채팅 초상화도 이제 "이 메시지가 속한 채널"의 마지막 표정만
        // 본다(전역 X). 메시지의 채널은 custom-chat-channels가 심어둔 channelId flag로
        // 판별하고(없으면 메인), 내부 식별자로 변환해 스탠딩 박스와 동일한 저장소를 조회한다.
        const realChannelId = message.getFlag(CHAT_CHANNELS_MODULE_ID, CHAT_CHANNELS_FLAG_KEY) || "";
        const messageChannelId = fromRealChannelId(realChannelId);
        const expressionImg = getLastExpressionForChannel(actor, messageChannelId);
        if (!expressionImg) return; // 활성 표정이 없으면 렌더 시점에 actor.img로 폴백 (3.3-1)

        message.updateSource({ [`flags.${MODULE_ID}.expressionImg`]: expressionImg });
      } catch (err) {
        console.error(`${LOG_PREFIX} 채팅 초상화 스냅샷 저장 중 오류:`, err);
      }
    });

    // ── [Phase 3] 채널 메시지 자동 대사 감지 ────────────────────────────────
    // 기존 일반 채팅 자동 감지 훅(위쪽, whisper 스킵 포함)은 손대지 않고 완전히 별도의
    // 훅으로 분리한다. custom-chat-channels가 쏘는 커스텀 이벤트만 구독하므로, 그 모듈이
    // 없는 환경에서는 이 훅 자체가 아예 호출되지 않는다(인계 문서 4장/5장 원칙).
    //
    // 이 메시지 문서는 이미 whisper로 참여자(+GM)에게만 격리되어 도착한 뒤이므로, 여기서
    // 별도 권한 검사 없이 처리해도 안전하다 — 참여하지 않은 클라이언트는 이 콜백 자체가
    // 호출되지 않는다. emit은 항상 false(=applyLocalOnly)로 고정한다: 채널 대사를 world
    // 상태로 브로드캐스트/영구저장하면 그 채널에 없는 플레이어의 화면에도 스탠딩 HUD가
    // 갱신되어 내용이 새어나가므로 절대 emit:true를 쓰면 안 된다.
    //
    // "myStandingChannel"(이 클라이언트가 스탠딩 버튼으로 튜닝 중인 채널)과 일치하는
    // 채널의 메시지만 스탠딩 박스에 반영한다 — 튜닝하지 않은 채널의 대사는 참여 중이라도
    // 스탠딩 박스를 바꾸지 않는다(채팅창에서는 정상적으로 보임, 스탠딩 연동만 대상).
    Hooks.on("customChatChannelsMessageCreated", (message, channelId) => {
      try {
        // [버그 5] myChannel은 내부 식별자(메인이면 STANDING_MAIN_CHANNEL_ID)로 저장되어
        // 있지만, 이 훅의 channelId 인자는 chat-channels가 실제로 쓰는 channelId(메인은
        // "")다. API 바깥에서 들어오는 실제 channelId와 비교하는 지점이므로 여기서
        // toRealChannelId로 변환해서 비교해야 한다.
        const myChannel = game.settings.get(MODULE_ID, "myStandingChannel") || "";
        if (!myChannel || channelId !== toRealChannelId(myChannel)) return;

        // [버그 1] 텍스트 추출 + speakAs/speakAsAlias 반영 로직을 TheatreApp.applyChannelMessage로
        // 옮겼다. 스탠딩 채널 전환 시 "마지막 대사" 즉시 복원(TheatreApp.loadChannelDisplay)도
        // 똑같은 메서드를 재사용하므로, 실시간으로 도착했을 때와 전환 직후 복원했을 때 결과가 항상 같다.
        // [Phase 4] channelId를 내부 식별자로 변환해 명시적으로 넘긴다(메인은 "" → STANDING_MAIN_CHANNEL_ID).
        theatreApp.applyChannelMessage(message, fromRealChannelId(channelId));
      } catch (err) {
        console.error(`${LOG_PREFIX} 채널 메시지 자동 대사 감지 중 오류:`, err);
      }
    });

    const CONTROL_BUTTON_ID = "custom-theatre-controls-manager";

    const addControlsManagerButton = () => {
      // Foundry V13의 토큰 도구 하위 메뉴에만 넣는다. 이 메뉴는 레이어를
      // 전환할 때마다 다시 그려지므로, 토큰 레이어가 활성화된 경우에만 추가한다.
      const tokenLayer = document.querySelector(
        '#scene-controls-layers [data-control="tokens"][aria-pressed="true"]'
      );
      const controlsList = document.querySelector("#scene-controls-tools");
      const existing = document.getElementById(CONTROL_BUTTON_ID);
      if (!tokenLayer || !controlsList) {
        existing?.remove();
        return;
      }
      if (existing?.parentElement === controlsList) return;
      existing?.remove();

      const item = document.createElement("li");
      item.id = CONTROL_BUTTON_ID;
      item.className = "custom-theatre-controls-manager";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "control ui-control tool icon fa-solid fa-masks-theater";
      button.dataset.tooltip = "무대 매니저 열기 (우클릭: 표정 선택 도우미)";
      button.setAttribute("aria-label", "무대 매니저 열기");
      button.addEventListener("click", () => openManagerSafely());
      // [표정 선택 도우미] 좌클릭(매니저)과 완전히 분리된 별도 진입점. 브라우저 기본
      // 우클릭 메뉴가 뜨지 않도록 막고, 이미 열려있어도 그대로 유지한다(닫기는 X 전용).
      button.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        openExpressionPickerSafely();
      });
      item.append(button);
      controlsList.append(item);
    };

    // 토큰 도구 메뉴가 다시 렌더되어도 ID 기반으로 하나만 유지한다.
    addControlsManagerButton();
    new MutationObserver(addControlsManagerButton).observe(document.body, { childList: true, subtree: true });

    game.modules.get(MODULE_ID).api = {
      show: (slots, text) => theatreApp.updateAndBroadcast(slots, text),
      clear: () => theatreApp.clearAll(),
      openManager: (actorId) => openManagerSafely(actorId),
      openExpressionPicker: () => openExpressionPickerSafely()
    };

    console.log(`${LOG_PREFIX} Ready and API loaded.`);
  } catch (err) {
    console.error(`${LOG_PREFIX} ready 단계 초기화 실패:`, err);
    ui.notifications.error("Custom Theatre 모듈 초기화 중 오류가 발생했습니다. 콘솔(F12)을 확인해주세요.");
  }
});

/**
 * ── 매크로가 채팅 로그에 심는 "스타일 전용" <style> 태그를 새로고침마다 되살린다 ──
 *
 * 배경: "WARNING 등장 배너", "루비글자" 같은 사용자 매크로들은 채팅 메시지 스타일을
 * ChatMessage.create()의 content HTML 안에 클래스(.warning-desc, .ruby-chat-message 등)로
 * 저장해두고, 그 클래스에 대응하는 <style>은 매크로 실행 시에만 document.head에 삽입한다.
 * 이 모듈(custom-theatre-system)과는 무관한 코드이지만, 새로고침 직후에는 그 매크로가
 * 아직 한 번도 실행되지 않아 <style>이 없으므로 과거 메시지가 스타일 없이 보인다
 * (실사용 중 확인된 증상). 이후 그 매크로가 아무 이유로든 다시 실행되면 그제서야
 * <style>이 생겨 과거 메시지에도 CSS 클래스 매칭으로 즉시 스타일이 적용되어, "재렌더링도
 * 안 했는데 갑자기 스타일이 바뀌는" 것처럼 보인다.
 *
 * 해결: "스타일만 심고 그 외 부작용(ChatMessage.create/Dialog 등)이 없는" 매크로만
 * 골라내어, ready 시점에 그 부분만 자동 실행해 <style>을 항상 존재하게 만든다.
 * 부작용이 있는 매크로(같은 파일 안에 ChatMessage.create나 Dialog가 섞여 있는 매크로)는
 * 의도적으로 제외한다 — 새로고침마다 채팅 메시지가 새로 생기거나 다이얼로그가 뜨는 것을
 * 막기 위함. 이 필터에 걸리게 하려면, 매크로 작성자가 "스타일 삽입 부분"과 "실행 부분
 * (메시지 생성/다이얼로그)"을 서로 다른 매크로로 분리해두어야 한다.
 *
 * 이 블록은 위 ready 훅과 완전히 독립된 별도 Hooks.once("ready", ...)이며, 기존 초기화
 * 로직(theatreApp 등)은 전혀 건드리지 않는다. 여기서 예외가 나도 위 블록에는 영향 없음.
 */
Hooks.once("ready", () => {
  const isStyleOnlyMacro = (command) => {
    if (typeof command !== "string") return false;
    const hasStyleInsertion =
      command.includes('createElement("style")') && command.includes("document.head.appendChild");
    const hasSideEffects = command.includes("ChatMessage.create") || command.includes("new Dialog");
    return hasStyleInsertion && !hasSideEffects;
  };

  try {
    const styleMacros = game.macros?.filter((m) => isStyleOnlyMacro(m.command)) ?? [];
    for (const macro of styleMacros) {
      try {
        macro.execute();
      } catch (err) {
        console.error(`${LOG_PREFIX} 부팅 시 스타일 매크로 자동 실행 실패 (${macro.name}):`, err);
      }
    }
    if (styleMacros.length) {
      console.log(
        `${LOG_PREFIX} 부팅 시 스타일 전용 매크로 ${styleMacros.length}개 자동 실행: ` +
          styleMacros.map((m) => m.name).join(", ")
      );
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} 부팅 시 스타일 매크로 자동 실행 단계 실패:`, err);
  }
});
