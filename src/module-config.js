export const MODULE_ID = "custom-theatre-system";
export const SOCKET_NAME = `module.${MODULE_ID}`;
export const DEFAULT_APPEARANCE = Object.freeze({
  nameColor: "#ffffff",
  nameFontSize: 16,
  chatFontSize: 17,
  standingScale: 1
});

export function normalizeAppearance(value = {}) {
  const numberInRange = (input, fallback, min, max) => {
    const number = Number(input);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  return {
    nameColor: /^#[0-9a-f]{6}$/i.test(value.nameColor || "") ? value.nameColor : DEFAULT_APPEARANCE.nameColor,
    nameFontSize: numberInRange(value.nameFontSize, DEFAULT_APPEARANCE.nameFontSize, 12, 32),
    chatFontSize: numberInRange(value.chatFontSize, DEFAULT_APPEARANCE.chatFontSize, 14, 30),
    standingScale: numberInRange(value.standingScale, DEFAULT_APPEARANCE.standingScale, 0.5, 2)
  };
}

export const MAX_CHAT_PORTRAIT_PRESETS = 3;

/**
 * 채팅 초상화 크롭 프리셋(3.2/3.3) 값을 안전한 범위로 정규화한다.
 * refImg는 편집 UI에서 미리보기용 대표 이미지로만 쓰이고, 실제 렌더링(main.js)에는
 * scale/offsetX/offsetY/bgColor만 적용된다.
 */
export function normalizeChatPortraitPreset(value = {}) {
  const numberInRange = (input, fallback, min, max) => {
    const number = Number(input);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  return {
    refImg: typeof value.refImg === "string" && value.refImg ? value.refImg : null,
    scale: numberInRange(value.scale, 1, 1, 6),
    offsetX: numberInRange(value.offsetX, 0, -50, 50),
    offsetY: numberInRange(value.offsetY, 0, -50, 50),
    // 배경색 미지정/취소 시 투명 (3.3)
    bgColor: /^#[0-9a-f]{6}$/i.test(value.bgColor || "") ? value.bgColor : null
  };
}

/**
 * 크롭 프리셋(3.2/3.3) 값을 실제 CSS 스타일로 변환한다.
 * 채팅 로그 렌더링(main.js)과 매니저 편집창 미리보기(GMManagerApp.js)가 이 함수를
 * 공유해서 써야, 편집창에서 본 크롭/이동이 실제 채팅에도 똑같이 나온다.
 *
 * (실사용 버그 수정 - 2차) object-fit: cover를 base로 쓰면 scale=1(확대 0%)인
 * 최초 상태에서도 정사각형을 꽉 채우기 위해 이미지 밖으로 나가는 부분을 무조건
 * 잘라버린다. 게다가 확대 슬라이더 최솟값이 1이라 축소해서 되돌릴 방법이 없어,
 * 세로로 긴 스탠딩일수록 위/아래가 처음부터 크게 잘려 보이는 치명적 문제가 있었다.
 * → base를 object-fit: contain(원본 전체가 항상 보이는 상태)으로 바꾸고, 그 위에
 * transform: scale()+translate()로 확대·이동을 얹는다. scale=1(기본값)이면 원본
 * 이미지 전체가 정사각형 안에 레터박스(빈 공간은 배경색으로 채움)로 그대로 보이고,
 * 확대를 올릴수록 원본 비율과 무관하게 필요한 만큼만 잘려나가는 정상적인 크롭
 * 편집기 동작이 된다. 미리보기/채팅 렌더링 쪽 wrap 요소는 반드시 overflow:hidden
 * 이어야 확대 시 밖으로 나가는 부분이 실제로 가려진다.
 */
export function getChatPortraitCropStyle(preset) {
  if (!preset) {
    // 프리셋 미지정: 크롭 없이 원본 비율 그대로 (1단계 동작과 동일)
    return {
      img: { width: "", height: "", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", objectPosition: "center", transform: "none" },
      background: "transparent"
    };
  }
  return {
    img: {
      width: "100%",
      height: "100%",
      maxWidth: "",
      maxHeight: "",
      objectFit: "contain",
      objectPosition: "center",
      transform: `scale(${preset.scale}) translate(${preset.offsetX}%, ${preset.offsetY}%)`,
      transformOrigin: "center center"
    },
    background: preset.bgColor || "transparent"
  };
}

/**
 * 표정 이미지(imgSrc)에 해당하는 크롭/배경 프리셋을 찾는다 (3.2/3.3, 4장).
 * expressions 항목의 presetIndex(0~2, 기본 0)로 어느 chatPortraitPresets 슬롯을 쓸지 결정한다.
 * 저장된 프리셋이 없으면 null을 반환하며, 이 경우 렌더링 쪽에서 1단계와 동일하게
 * 크롭 없이 원본 그대로(object-fit: contain, 배경 투명) 표시한다.
 *
 * [표정 선택 도우미] main.js(채팅 초상화 렌더링)와 ExpressionPickerWidget.js(썸네일 미리보기)가
 * 완전히 동일한 로직을 공유해야 두 곳에 보이는 크롭이 항상 일치하므로, 여기 공용 헬퍼로 둔다.
 */
export function getChatPortraitPreset(actor, imgSrc) {
  const expressions = actor.getFlag(MODULE_ID, "expressions") ?? [];
  const expression = expressions.find((e) => e.img === imgSrc);
  const presetIndex = expression?.presetIndex ?? 0;
  const presets = actor.getFlag(MODULE_ID, "chatPortraitPresets") ?? [];
  const raw = presets[presetIndex];
  return raw ? normalizeChatPortraitPreset(raw) : null;
}

/**
 * 판정 채팅은 시스템이 계산 상세를 함께 출력하는 경우가 많다. 극장 대사창에는
 * 첫 결과(예: [보통 성공])만 보여 주고, 일반 대사는 원문 전체를 유지한다.
 *
 * [버그 1] 원래 main.js에만 있던 함수를 여기로 옮겼다. TheatreApp.js(스탠딩 채널
 * 전환 시 "마지막 대사" 복원)와 main.js(실시간 채널 메시지 감지) 양쪽에서 완전히
 * 동일한 텍스트 추출 로직을 써야 두 경로의 결과가 항상 일치하는데, main.js →
 * TheatreApp.js 방향으로만 import가 가능한 구조(main.js가 TheatreApp을 import)라서
 * TheatreApp.js가 main.js를 직접 import하면 순환 참조가 된다. 두 파일 모두 이미
 * import하고 있는 이 module-config.js에 두면 순환 없이 공유할 수 있다.
 */
export function getTheatreChatText(message) {
  const content = message.content ?? "";
  const parser = document.createElement("div");
  parser.innerHTML = content;

  // 중요(원인 확정): innerText는 요소가 실제로 문서에 연결되어 레이아웃이 계산된
  // 상태에서만 (1) 블록 요소 경계마다 줄바꿈을 넣어주고 (2) display:none 등으로
  // 숨겨진 구간(예: 무기 판정 카드의 GM 전용 숨김 섹션)을 정확히 제외해 준다.
  // 분리된(detached) <div>에서는 브라우저가 레이아웃을 계산하지 못해 innerText가
  // textContent와 동일하게 동작한다 — 즉 숨김 섹션까지 포함한 모든 텍스트가 줄바꿈
  // 없이 한 줄로 이어붙는다. "[결과]" 형태의 대괄호 요약이 있는 일반 판정은 정규식이
  // 그 부분만 뽑아내므로 이 문제를 우연히 피해갔지만, 대괄호 요약이 없는 카드(예:
  // [대 크리쳐 살상탄] 같은 무기 공격탄 판정)는 첫 줄만 남기는 폴백 로직이 사실상
  // 전체 카드를 한 줄로 반환해버리는 문제가 있었다(실사용 중 확인됨).
  // 화면에는 보이지 않되 실제로 문서에 붙여 레이아웃/CSS가 정상 계산되게 한 뒤 읽는다.
  parser.style.cssText = "position:fixed; top:-9999px; left:-9999px; visibility:hidden; pointer-events:none;";
  document.body.appendChild(parser);
  let text;
  let cardTitle;
  let isDamageApplyCard;
  try {
    // [v1.8.10] Midi-QOL이 공격 적중 후 "피해 적용" UI(HP 업데이트 됨 표, 배율
    // 선택/적용/취소 버튼)를 GM 자신에게만 whisper로 보내는 카드. 실제 대사/판정
    // 결과가 아니라 GM 전용 조작 UI이므로 대사창에는 아예 아무것도 띄우지 않는다.
    // 이 카드는 항상 .xmidi-qol-flex-container로 감싼 테이블(헤더 id
    // "midi-qol-dmg-header")로만 오므로, 다른 어떤 판정/대사 카드와도 겹치지 않는다.
    isDamageApplyCard = Boolean(
      parser.querySelector(".xmidi-qol-flex-container, #midi-qol-dmg-header")
    );

    // CoC7 계열 판정/공격/피해 카드는 판정 요청 단계든 결과 단계든 항상 동일하게
    // .coc7-chat-header .card-title 안에 판정명만 담고(예: "대 크리쳐 살상탄"), 그 아래
    // 발포/사격모드/난이도/보너스·페널티 주사위/다이스 상세/GM 전용 버튼(고통을 입힘 등)은
    // 전부 부가 정보로 별도 블록에 나온다(실제 채팅 카드 마크업으로 확인됨). 대사창에는
    // 이 카드 제목만 노출하고 나머지는 전부 생략한다.
    cardTitle = parser.querySelector(".coc7-chat-header .card-title")?.textContent?.trim() || "";

    // [v1.8.9] DND5e(Midi-QOL activation-card 등)는 판정 상세("tray")가 시스템 JS가
    // 실제 채팅 로그에 렌더링된 뒤에 접히는 방식(dnd5e 코어 ChatLog5e가 접힘 상태를
    // 저장·복원)이라, 분리된(detached) <div>에서는 그 JS가 실행되지 않아 전부 펼쳐진
    // 채로 텍스트에 다 나온다. 카드 제목(판정/주문/아이템 이름)은 항상
    // .chat-card .card-header .name-stacked .title 안에만 있고, 그 아래(공격/피해
    // 굴림, 대상 tray 등)는 전부 부가 정보이므로 제목만 남기고 나머지는 생략한다.
    // COC7 로직과 완전히 격리: dnd5e 시스템일 때만, 그리고 cardTitle이 이미 안
    // 잡혔을 때만 시도한다. 셀렉터가 안 맞으면(다른 카드 종류 등) 빈 문자열이 나와
    // 아래 기존 폴백(대괄호 요약 → 첫 줄만)으로 자연스럽게 넘어간다.
    if (!cardTitle && game.system?.id === "dnd5e") {
      cardTitle = parser.querySelector(".chat-card .card-header .name-stacked .title")?.textContent?.trim() || "";
    }

    text = (parser.innerText || parser.textContent || "").trim();
  } finally {
    parser.remove();
  }

  if (isDamageApplyCard) return "";

  if (cardTitle) return cardTitle;

  const isRoll = Boolean(message.isRoll || message.rolls?.length);
  if (!isRoll) return text;

  // CoC 계열 시스템의 결과 표기와 같은 대괄호 첫 결과가 있으면 우선 사용한다.
  const summary = text.match(/^\s*(\[[^\]\r\n]+\])/m)?.[1];
  if (summary) return summary;
  // 그 외의 판정 카드(무기 공격탄 등 대괄호 요약이 없는 경우)도 이제 줄바꿈이 올바르게
  // 분리되므로, 카드 제목(첫 줄)만 남고 발포/난이도/주사위 결과/숨김 섹션 등 나머지
  // 판정 상세는 대사창에 노출되지 않는다.
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

// ── [Phase 3] 스탠딩 박스 채널 버튼 ──────────────────────────────────────
// custom-chat-channels가 설치/활성화되어 있을 때만 의미가 있는 설정들. 해당 모듈이
// 없으면 main.js에서 이 값들을 아예 읽지 않고 버튼 UI 자체를 숨긴다.
export const MAX_STANDING_CHANNELS = 3;
const CHAT_CHANNELS_MODULE_ID = "custom-chat-channels";

/**
 * [버그 5] chat-channels의 "메인" 탭은 정식 채널이 아니라 MAIN_CHANNEL_ID = ""(빈 문자열)
 * 특수값으로만 표현된다. 그런데 theatre 쪽 세 설정(standingEligibleChannels의 빈 슬롯,
 * myStandingChannel, forcedChannelId)도 "연동 없음/미지정"을 똑같이 빈 문자열로 표현하므로,
 * 그 값을 그대로 저장하면 "메인 선택됨"과 "아무것도 선택 안 함"이 서로 구분되지 않는다
 * (예: `if (!myChannel) return;` 같은 기존 가드가 "메인 연동 중"도 "연동 안 함"으로 오인해
 * 걸러버림).
 *
 * 해결: theatre 쪽에서만 쓰는 이 내부 식별자로 "메인"을 표현해 **저장**한다. chat-channels
 * API를 **실제로 호출하는 지점**(setActiveChannel, getLastChannelMessage 등)과, API 바깥에서
 * 들어오는 **실제** channelId(customChatChannelsMessageCreated 훅 인자 등)와 비교하는
 * 지점에서만 toRealChannelId()로 실제 MAIN_CHANNEL_ID("")로 변환해서 쓴다. 그 외(설정
 * 저장/비교, 버튼 active/forced 판정 등)는 내부 식별자를 그대로 문자열 비교하면 되므로
 * 별도 변환이 필요 없다.
 */
export const STANDING_MAIN_CHANNEL_ID = "__main__";
export const STANDING_MAIN_CHANNEL_LABEL = "메인";

/** 내부 식별자를 chat-channels API가 실제로 이해하는 채널 id로 변환한다. */
export function toRealChannelId(internalId) {
  return internalId === STANDING_MAIN_CHANNEL_ID ? "" : internalId;
}

/** [Phase 4] toRealChannelId()의 역변환. chat-channels가 실제로 쓰는 channelId("" = 메인)를
 * theatre 쪽 내부 식별자(STANDING_MAIN_CHANNEL_ID)로 되돌린다. customChatChannelsMessageCreated
 * 훅 인자나 getActiveChannelId() 반환값처럼 "API 바깥에서 들어오는 실제 channelId"를 theatre
 * 내부 맵의 키로 쓸 때 이 함수를 거친다. */
export function fromRealChannelId(realId) {
  return realId ? realId : STANDING_MAIN_CHANNEL_ID;
}

/**
 * [Phase 4] currentState world 설정의 채널별 상태 맵 스키마.
 * 옛 버전(Phase 4 이전, 단일 평면 객체 {slots, text, speakerName, speakerActorId,
 * speakerAppearance, lockedSlots, updatedAt})을 감지하면 메인 채널 상태로 감싸 새
 * 맵 형태({channelId: {slots, text, speakerName, speakerActorId, speakerAppearance, updatedAt}})로
 * 변환한다(하위 호환 마이그레이션). 이미 맵 형태면 그대로 반환한다(불변 원본은 건드리지 않음).
 * lockedSlots는 Phase 4부터 채널과 무관한 전역 값이라 이 맵에 포함하지 않는다(별도 설정 "lockedSlots").
 */
export function migrateChannelStateMap(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.slots)) {
    return {
      [STANDING_MAIN_CHANNEL_ID]: {
        slots: raw.slots,
        text: raw.text || "",
        speakerName: raw.speakerName || "",
        speakerActorId: raw.speakerActorId || null,
        speakerAppearance: raw.speakerAppearance || {},
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
      }
    };
  }
  return raw && typeof raw === "object" ? raw : {};
}

export const DEFAULT_CHANNEL_STATE = Object.freeze({
  slots: [null, null, null, null],
  text: "",
  speakerName: "",
  speakerActorId: null,
  speakerAppearance: {},
  updatedAt: 0
});

/**
 * [Phase 4] 채널별 상태 맵에서 특정 채널의 상태를 꺼낸다. 없으면 빈 기본 상태를 반환.
 * [버그 수정] slots/speakerAppearance는 항상 새 배열·새 객체로 복사해서 반환한다 — 원본
 * entry.slots를 그대로 넘기면, 호출부가 그 배열을 직접 mutate(next[i]=...)할 때 저장된
 * 원본까지 같이 바뀌어버리고, 심하면 다른 채널이 같은 배열 객체를 참조하게 되어 한 채널의
 * 슬롯 변경이 다른 채널에도 그대로 새어 들어가는 원인이 된다(참조 공유 버그).
 */
export function getChannelState(map, channelId) {
  const entry = map?.[channelId];
  if (!entry) return { slots: [null, null, null, null], text: "", speakerName: "", speakerActorId: null, speakerAppearance: {}, updatedAt: 0 };
  return {
    slots: Array.isArray(entry.slots) ? entry.slots.map((slot) => (slot ? { ...slot } : null)) : [null, null, null, null],
    text: entry.text || "",
    speakerName: entry.speakerName || "",
    speakerActorId: entry.speakerActorId || null,
    speakerAppearance: entry.speakerAppearance ? { ...entry.speakerAppearance } : {},
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0
  };
}

/**
 * [표정 오염 수정] 액터의 "채널별 마지막 표정" 플래그 키. 과거에는 `chatPortraitLastExpression`
 * 하나(전역, 채널 무관)만 있었으나, 이 값을 스탠딩 박스(speakAs 가지 B)와 채팅 로그 옆
 * 초상화 두 곳에서 그대로 폴백으로 읽어 쓰다 보니 "한 채널에서 바꾼 표정이 다른 채널에도
 * 새어 들어가는" 오염이 발생했다. 이제 채널ID(내부 식별자, 메인이면
 * STANDING_MAIN_CHANNEL_ID)를 키로 하는 객체 하나로 통합해서 두 기능이 함께 쓴다 — 같은
 * "이 채널에서 마지막으로 지정된 표정"이라는 동일한 개념이라 저장소를 하나로 합쳤다.
 * 옛 전역 플래그(`chatPortraitLastExpression`)는 더 이상 쓰지 않는다(마이그레이션 없이
 * 그대로 방치 — 새 채널별 값이 없으면 등록된 첫 표정으로 폴백하므로 안전하다).
 */
const CHAT_PORTRAIT_LAST_EXPRESSION_FLAG = "chatPortraitLastExpressionByChannel";

/** 액터의 특정 채널에서의 마지막 표정 이미지를 조회한다. 없으면 null. */
export function getLastExpressionForChannel(actor, channelId) {
  const byChannel = actor?.getFlag(MODULE_ID, CHAT_PORTRAIT_LAST_EXPRESSION_FLAG) ?? {};
  return byChannel[channelId] ?? null;
}

/** 액터의 특정 채널에서의 마지막 표정 이미지를 갱신한다(다른 채널의 값은 그대로 둔다). */
export async function setLastExpressionForChannel(actor, channelId, expressionImg) {
  const byChannel = actor?.getFlag(MODULE_ID, CHAT_PORTRAIT_LAST_EXPRESSION_FLAG) ?? {};
  return actor.setFlag(MODULE_ID, CHAT_PORTRAIT_LAST_EXPRESSION_FLAG, { ...byChannel, [channelId]: expressionImg });
}

/**
 * 삭제된 표정 이미지를 참조하고 있는 채널 항목을 전부 제거한다(참조 무결성).
 * 아무 채널도 그 이미지를 참조하지 않았으면 아무 것도 하지 않는다.
 */
export async function clearLastExpressionReferences(actor, expressionImg) {
  const byChannel = actor?.getFlag(MODULE_ID, CHAT_PORTRAIT_LAST_EXPRESSION_FLAG) ?? {};
  const next = {};
  let changed = false;
  for (const [channelId, img] of Object.entries(byChannel)) {
    if (img === expressionImg) { changed = true; continue; }
    next[channelId] = img;
  }
  if (changed) await actor.setFlag(MODULE_ID, CHAT_PORTRAIT_LAST_EXPRESSION_FLAG, next);
}

/**
 * [월드별 표정 폴더] Foundry 코어는 파일 삭제 API/UI를 제공하지 않아(GM도 코어
 * 파일 브라우저에서 지울 수 없음이 실사용으로 확인됨) 자동 삭제 대신 "월드별로
 * 폴더를 나눠 저장 + 안 쓰는 파일 찾아주기" 방식으로 정리 부담을 줄인다.
 *
 * 지금까지는 모든 월드가 modules/custom-theatre-system/storage/expressions
 * 바로 밑에 뒤섞여 저장됐다. 이제부터는 그 아래에 월드 id로 된 하위 폴더
 * (.../expressions/<worldId>/)를 만들어 그 안에만 저장한다.
 * 기존에 이미 루트에 저장된 파일들은 건드리지 않는다(경로가 actor.expressions
 * 플래그에 그대로 남아있어야 계속 정상 표시되므로).
 */
export function getWorldExpressionsFolder() {
  const raw = game.world?.id || "unknown-world";
  // 월드 id는 보통 이미 파일명으로 안전한 슬러그지만, 혹시 모를 특수문자만 방어적으로 제거.
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "-") || "unknown-world";
  return `expressions/${safe}`;
}

/** 위 폴더의 전체 서버 경로(모듈 저장소 기준). */
export function getWorldExpressionsFullPath() {
  return `modules/${MODULE_ID}/storage/${getWorldExpressionsFolder()}`;
}

/**
 * 월드 구분 전(과거)에 표정 이미지가 쌓였던 루트 폴더의 전체 서버 경로.
 * [v1.9.5] "미사용 표정 파일 찾기"에 이 폴더를 옵션으로 포함시키기 위해 추가.
 * 주의: 이 폴더는 다른 월드가 지금도 쓰고 있을 수 있고, 클라이언트는 현재 월드의
 * 액터 데이터만 읽을 수 있어 다른 월드의 사용 여부를 확인할 방법이 없다.
 */
export function getRootExpressionsFullPath() {
  return `modules/${MODULE_ID}/storage/expressions`;
}

/**
 * 현재 월드의 표정 폴더가 없으면 만든다. 이미 있으면(가장 흔한 경우) 에러가 나는데
 * 정상 상황이라 조용히 무시한다. createDirectory 자체도 삭제와 마찬가지로 파일
 * 관리 권한이 필요할 수 있어, 실패하면 예외를 그대로 올려서 호출부(업로드 로직)가
 * "GM이 먼저 폴더를 만들어야 한다"는 안내를 띄울 수 있게 한다.
 */
export async function ensureWorldExpressionsFolder() {
  // [실사용 확인 전제] createDirectory가 실패하는 이유(이미 있음/권한 없음 등)를
  // 메시지 문자열로 구분하려 하지 않는다 — 정확한 에러 문구를 검증하지 못했기
  // 때문. 어차피 진짜 문제(권한 없음 등)라면 뒤이은 업로드 시도가 Foundry
  // 자체의 명확한 에러 알림으로 드러나므로, 여기서는 조용히 시도만 해본다.
  try {
    await FilePicker.createDirectory("data", getWorldExpressionsFullPath(), {});
  } catch (err) {
    console.warn(`[Custom Theatre] 월드 표정 폴더 생성 시도 결과(이미 있으면 정상):`, err);
  }
}

/**
 * [v1.9.5] 기본적으로 현재 월드 표정 폴더(expressions/<worldId>/)를 스캔해서
 * "실제 폴더 안 파일 배치 그대로" 전체 파일 목록을 돌려준다. 각 항목에는 지금
 * 이 월드의 어떤 액터 표정 목록에도 안 걸려있는지(used:false)를 표시해서, 호출부
 * (UI)가 미사용 파일만 강조 표시할 수 있게 한다. FilePicker.browse는 하위 폴더까지
 * 재귀적으로 뒤지지 않으므로 Not_used/ 밑으로 옮겨진 파일은 여기 다시 걸리지 않는다.
 *
 * [정렬용 날짜] Foundry의 FilePicker.browse는 파일별 수정 시각을 주지 않는다.
 * 대신 각 파일에 HEAD 요청을 보내 서버가 응답하는 Last-Modified 헤더를 읽어
 * date(ms epoch)로 채운다 — 호스팅 환경에 따라 헤더가 없을 수 있어 "가능할 경우"만
 * 채워지고, 실패하면 date:null로 남는다(호출부가 날짜순 정렬 시 이름순 등으로
 * 대체해야 함).
 *
 * @param {object} [options]
 * @param {boolean} [options.includeLegacyRoot=false] true면 월드 구분 전(과거)
 *   루트 폴더(expressions/ 바로 밑)도 같이 스캔한다. [v1.9.5] 단, 이 루트 폴더는
 *   다른 월드가 지금도 쓰고 있을 수 있고 클라이언트에서는 그걸 확인할 방법이
 *   없어서, "진짜 미사용"을 보장하지 못한다 — 호출부(UI)가 이 사실을 GM에게
 *   반드시 경고해야 한다. 반환 항목의 legacy:true가 이 폴더에서 나온 것이다.
 * @returns {Promise<{path: string, legacy: boolean, used: boolean, date: number|null}[]>}
 */
export async function scanExpressionFolderFiles({ includeLegacyRoot = false } = {}) {
  const referenced = new Set();
  for (const actor of game.actors ?? []) {
    const expressions = actor.getFlag(MODULE_ID, "expressions") ?? [];
    for (const expr of expressions) {
      if (expr?.img) referenced.add(expr.img);
    }
  }

  const scanFolder = async (folderPath, legacy) => {
    let browsed;
    try {
      browsed = await FilePicker.browse("data", folderPath);
    } catch (_err) {
      // 폴더가 아직 한 번도 안 만들어졌으면 빈 목록.
      return [];
    }
    const filesOnDisk = browsed?.files ?? [];
    return filesOnDisk.map((path) => ({ path, legacy, used: referenced.has(path) }));
  };

  const results = await scanFolder(getWorldExpressionsFullPath(), false);
  if (includeLegacyRoot) {
    results.push(...(await scanFolder(getRootExpressionsFullPath(), true)));
  }

  await attachFileDates(results);

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * [v1.9.5] 각 항목에 HEAD 요청을 보내 Last-Modified 헤더를 date(ms epoch)로 채운다.
 * 헤더가 없거나 요청 자체가 실패하면 date:null로 남긴다. 파일이 많을 때 한 번에
 * 전부 요청을 쏘지 않도록 CONCURRENCY개씩 나눠 처리한다.
 */
async function attachFileDates(items) {
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        const res = await fetch(item.path, { method: "HEAD", cache: "no-store" });
        const lastModified = res.headers?.get?.("Last-Modified");
        const parsed = lastModified ? Date.parse(lastModified) : NaN;
        item.date = Number.isNaN(parsed) ? null : parsed;
      } catch (_err) {
        item.date = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/**
 * [v1.9.5] 이전에는 여기서 "미사용 파일을 Not_used/ 폴더로 이동(복사+원본삭제)"을
 * 시도했다. Foundry는 module 공개 API로 파일 삭제/이동을 제공하지 않고, 코어
 * 내부 비공식 소켓 이벤트("manageFiles"/"delete")로 우회하는 방식도 실사용에서
 * 응답 없이 무시됨이 확인됐다. 그 결과 복사(업로드)만 항상 성공하고 원본 삭제는
 * 항상 실패해 사본만 계속 쌓이는 역효과가 있어 기능 자체를 제거했다. 정리는
 * scanExpressionFolderFiles로 찾은 목록(used:false 항목)을 GM이 서버 파일시스템에서
 * 직접 지우는 방식으로 한다.
 */

/**
 * [Phase 4, 3-1 결정] 채널별 상태 맵을 "스탠딩 노출 채널(최대 MAX_STANDING_CHANNELS)+메인"으로만
 * 한정해 정리한다 — 참여 중인 모든 채널이 아니라, GM이 스탠딩 버튼바에 실제로 노출시킨 채널만
 * 상태를 유지 대상으로 삼는다는 결정에 따른 것. 노출 목록에서 빠진 채널의 옛 항목은 정리된다.
 */
export function pruneChannelStateMap(map, eligibleChannelIds) {
  const keep = new Set([STANDING_MAIN_CHANNEL_ID, ...(eligibleChannelIds || []).filter(Boolean)]);
  const result = {};
  for (const key of Object.keys(map || {})) {
    if (keep.has(key)) result[key] = map[key];
  }
  return result;
}

/**
 * custom-chat-channels가 설치/활성화되어 있지 않으면 null을 반환하며, 호출부는
 * 이 경우 채널 버튼 UI 자체를 그리지 않는다. 정적 import 대신 game.modules.get(...).api를
 * 쓰는 이유는 두 모듈이 완전히 독립된 별도 ESM이라 서로의 파일을 직접 import할 수 없기
 * 때문(인계 문서 5장 "훅 기반 삽입" 원칙과 동일한 이유로, 여기서는 공개 API 객체를 그
 * 대신 쓴다). main.js와 TheatreApp.js 양쪽에서 공유해서 쓸 수 있도록 여기 둔다.
 */
export function getChatChannelsApi() {
  const mod = game.modules.get(CHAT_CHANNELS_MODULE_ID);
  return mod?.active ? mod.api ?? null : null;
}

/**
 * [표정 선택 도우미] "@태그/명령이 지금 어느 채널 것인지"는 스탠딩 튜닝 채널이 아니라,
 * 지금 이 사람이 채팅창에서 보고 있는 활성 탭(activeChannelId) 기준이라는 결정(Phase 4,
 * 3-3/3-4)을 그대로 재사용한다. custom-chat-channels가 없거나 비활성이면 항상 메인
 * 채널로 취급한다. main.js의 chatMessage 훅과 ExpressionPickerWidget.js가 이 계산을
 * 공유해야 "@표정 태그로 바꿀 때"와 "도우미 창 버튼으로 바꿀 때"가 항상 같은 채널을
 * 대상으로 삼는다.
 */
export function getActiveStandingChannelId() {
  const chatChannelsApi = getChatChannelsApi();
  return fromRealChannelId(chatChannelsApi?.getActiveChannelId?.() ?? "");
}

/**
 * [Phase 3, 3장] GM이 슬롯별 드롭다운으로 지정한 채널 id 목록을 정리한다.
 * 항상 정확히 MAX_STANDING_CHANNELS 길이의 배열을 반환하며, 배열의 인덱스가 곧 슬롯
 * 번호(0-based)를 의미한다. 빈 슬롯은 빈 문자열("")로 채워 인덱스를 유지한다.
 * 같은 채널이 방어적으로 중복 저장된 경우 먼저 나온 슬롯만 유지하고 나머지는 비운다
 * (UI에서 이미 드롭다운 disabled로 막지만, 저장 데이터 자체도 항상 중복 없이 보장한다).
 */
export function normalizeStandingEligibleChannels(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (let i = 0; i < MAX_STANDING_CHANNELS; i++) {
    const id = source[i];
    if (typeof id === "string" && id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    } else {
      result.push("");
    }
  }
  return result;
}

/** Foundry V13의 Handlebars API와 이전 API를 모두 지원한다. */
export function getRenderTemplateFn() {
  return foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate;
}

export function getLoadTemplatesFn() {
  return foundry?.applications?.handlebars?.loadTemplates ?? loadTemplates;
}

/**
 * 채팅 로그 초상화의 표시 크기(px)/라운드니스(모듈 설정, main.js에서 등록).
 * GM 매니저 표정 편집(2단계)의 크롭 프리셋과는 별개의 값으로, 초상화 wrapper
 * 자체의 가로세로 크기와 모서리 둥글기(0=사각형, 1=완전한 원)를 결정한다.
 */
export const DEFAULT_CHAT_PORTRAIT_SIZE = 65;
export const DEFAULT_CHAT_PORTRAIT_ROUNDNESS = 0.25;
const CHAT_PORTRAIT_SIZE_MIN = 16;
const CHAT_PORTRAIT_SIZE_MAX = 200;

export function normalizeChatPortraitSize(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(CHAT_PORTRAIT_SIZE_MAX, Math.max(CHAT_PORTRAIT_SIZE_MIN, Math.round(number)))
    : DEFAULT_CHAT_PORTRAIT_SIZE;
}

export function normalizeChatPortraitRoundness(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : DEFAULT_CHAT_PORTRAIT_ROUNDNESS;
}

/** wrapper(.ctp-chat-portrait)에 바로 Object.assign할 수 있는 크기/라운드니스 스타일. */
export function getChatPortraitDisplayStyle(sizePx, roundness) {
  const size = normalizeChatPortraitSize(sizePx);
  const radius = normalizeChatPortraitRoundness(roundness);
  return {
    width: `${size}px`,
    height: `${size}px`,
    flex: `0 0 ${size}px`,
    // 라운드니스 0~1을 0%~50%로 매핑: wrapper가 정사각형이므로 50%에서 완전한 원이 된다.
    borderRadius: `${radius * 50}%`
  };
}
