import {
  MODULE_ID,
  SOCKET_NAME,
  DEFAULT_APPEARANCE,
  getRenderTemplateFn,
  normalizeAppearance,
  MAX_STANDING_CHANNELS,
  normalizeStandingEligibleChannels,
  getChatChannelsApi,
  getTheatreChatText,
  STANDING_MAIN_CHANNEL_ID,
  STANDING_MAIN_CHANNEL_LABEL,
  toRealChannelId,
  migrateChannelStateMap,
  getChannelState,
  pruneChannelStateMap,
  getLastExpressionForChannel
} from "./module-config.js";

// 무대 HUD z-index 배치 모드.
// "top": 기존 동작 그대로(다른 모든 UI보다 위, 예: 스페이스 일시정지 아이콘보다도 위).
// "behind": 다른 Foundry UI(컨트롤/사이드바/일시정지 등)보다는 뒤로, 그러나 맵시트·타일 등
//   캔버스 콘텐츠보다는 앞에 오도록 하는 값. Foundry 코어 UI가 보통 20~30대 z-index를 쓰므로
//   그보다 낮고 캔버스(기본적으로 훨씬 낮음)보다는 높은 값을 사용한다.
const HUD_Z_INDEX_TOP = 60;
const HUD_Z_INDEX_BEHIND = 15;

// [Phase 3, 4장] custom-chat-channels의 chat-log-ui.js에 있는 truncateTabName()과 완전히
// 동일한 규칙(4글자 초과 시 앞 4글자 + "…")을 그대로 복제한다. 두 모듈이 완전히 분리된
// 별도 ESM이라 함수를 직접 import할 수 없어 로직을 이 파일에도 따로 둔다 — chat-channels
// 쪽 truncateTabName()의 규칙이 바뀌면 이 함수도 반드시 같이 바꿔야 로직이 갈라지지 않는다.
function truncateStandingChannelName(name) {
  if (name.length <= 4) return name;
  return `${name.slice(0, 4)}…`;
}

const LOCAL_POSITION_KEY = `${MODULE_ID}.hudPosition`;
const LOCAL_LOCK_KEY = `${MODULE_ID}.hudPositionLocked`;
const LOCAL_LAYOUT_KEY = `${MODULE_ID}.hudLayout`;
const LOCAL_TYPOGRAPHY_KEY = `${MODULE_ID}.hudTypography`;
const MAX_HISTORY_PAGES = 20;
const LINES_PER_PAGE = 4; // 세로(줄 수)는 고정 4줄 유지 — 대사창 높이와 무관.
// 가로 폭 기준 줄바꿈은 "글자 수 어림"이 아니라, 실제 폰트로 렌더링했을 때의
// 픽셀 폭을 canvas.measureText로 직접 재서 계산한다 (_wrapTextToWidth 참고).
// 문자 수 기반 어림(예: 폭 비례 46자)은 한글/영문/기호가 섞이면 실제 렌더 폭과
// 어긋나서 줄 끝에 불필요한 여백이 남는 문제가 있었다.
const TEXTBOX_HORIZONTAL_PADDING_PX = 28; // .theatre-textbox padding 좌/우 (각각)
const TEXTBOX_BORDER_PX = 1; // .theatre-textbox border 두께 (좌/우 각각, box-sizing: border-box라 실제 콘텐츠 폭에서 빠져야 함)
const TEXTBOX_SAFETY_MARGIN_PX = 6; // canvas measureText()와 실제 브라우저 텍스트 렌더링 간 오차 대비 여유폭
const FALLBACK_FONT_FAMILY = "Signika, \"Noto Sans KR\", sans-serif"; // .textbox-content 실제 엘리먼트를 아직 못 읽었을 때만 사용하는 폴백
const TYPE_INTERVAL_MS = 85;
const AUTO_ADVANCE_DELAY_MS = 3000;
const DEFAULT_HUD_WIDTH = 880;
const DEFAULT_TEXTBOX_HEIGHT = 168;
const DEFAULT_GLOBAL_STANDING_SCALE = 1;
const DEFAULT_STANDING_SPACING = 0.8;
const AUTO_SLOT_PRIORITY = [1, 2, 0, 3]; // 화면/매니저 표기 기준: 2 → 3 → 1 → 4

export class TheatreApp {
  constructor() {
    this.slots = [null, null, null, null];
    this.currentText = "";
    this.currentSpeakerName = "";
    this.currentSpeakerActorId = null;
    this.currentSpeakerAppearance = { ...DEFAULT_APPEARANCE };
    this.lockedSlots = [false, false, false, false];
    this.minimized = false;
    this.element = null;
    this.positionLocked = localStorage.getItem(LOCAL_LOCK_KEY) === "true";
    this.hudLayout = this._loadLocalLayout();
    this._dialogueHistory = [];
    this._standingImagePreloads = new Map();
    // 이미지 preload가 끝나는 순서와 수신 순서가 달라져 과거 상태가 나중에
    // 화면을 덮어쓰지 않도록, 가장 최근 상태 요청만 렌더링한다.
    this._stateRequestId = 0;
    // 현재 대사(모든 페이지)가 다 끝나기 전에 새로운 상태가 들어오면
    // 여기 잠시 보관했다가, 현재 대사를 끝까지 다 읽은 시점에 적용한다.
    this._pendingState = null;
    this._dialogue = {
      sourceKey: "",
      rawText: "",
      pages: [],
      pageIndex: 0,
      typedChars: 0,
      historyIndex: -1,
      manualNavigation: false,
      awaitingAdvance: false,
      typingTimer: null,
      autoAdvanceTimer: null
    };

    // 자동 발화 처리용 상태 (액터 단위)
    // [Phase 4] LRU 판단(lastSpokenAt)은 채널마다 슬롯이 독립되므로 채널별로 분리해서 유지한다
    // ({ channelId: { actorId: timestamp } }). 표정 기억(lastExpressionByActor)은 채팅 초상화의
    // chatPortraitLastExpression flag와 마찬가지로 액터 단위 전역 값으로 유지한다(채널과 무관).
    this.lastSpokenAtByChannel = {};
    this.lastExpressionByActor = {}; // { actorId: imgPath } - 마지막으로 쓰인 표정 기억

    // [Phase 4] 지금 화면에 표시(렌더) 중인 채널의 내부 식별자. 이 값과 다른 channelId로
    // 상태 변경이 들어오면(예: 다른 채널에서 온 대사) 화면은 건드리지 않고 그 채널의
    // 저장값만 갱신한다(3-1/3-2 결정). 채널 전환 시(loadChannelDisplay)에만 이 값이 바뀐다.
    this.currentChannelId = STANDING_MAIN_CHANNEL_ID;
    // 마지막으로 실제 화면에 반영(render)된 채널. _applyState의 "동일 상태면 스킵" 최적화가
    // 채널 전환 자체(내용은 우연히 같아도 버튼 바 활성 표시는 갱신돼야 함)를 건너뛰지 않도록
    // currentChannelId와 별도로 추적한다.
    this._lastAppliedChannelId = null;

    // ── [CT-FIX] 오래된 상태가 최신 상태를 덮어쓰지 못하도록 하는 버전 가드 ──
    // 소켓(UPDATE_THEATRE)이나 world Setting(currentState)을 통해 "되돌아오는"
    // 상태는, 여러 클라이언트/여러 저장 요청이 겹칠 때 도착 순서가 뒤집힐 수 있다.
    // 각 상태 스냅샷에 생성 시각(updatedAt)을 함께 실어보내고, 이미 그보다
    // 최신인 상태가 화면에 적용돼 있다면 오래된 스냅샷은 조용히 무시한다.
    // [버그 수정, 핵심] 이 값이 전역 단일 필드였던 게 "채널 전환해도 표정이 안 바뀌는" 근본
    // 원인이었다 — 예: B채널을 방금 고쳐 이 값이 T_B가 됐는데, C채널로 전환해 C의 저장된
    // 상태(시각 T_C, T_C < T_B)를 불러오면, 아래 stale-guard가 "이미 더 최신(T_B)이 적용돼
    // 있는데 그보다 오래된(T_C) 상태가 왔다"고 오인해 조용히 무시해버렸다. 채널마다 독립된
    // 시계를 가져야 한다.
    this._lastAppliedUpdatedAtByChannel = {};

    // 대사창 줄바꿈 폭 측정(canvas measureText)에 쓰는 폰트는 .textbox-content의
    // font-family를 최초 1회 읽어 캐시한다. 이 캐시 자체(문자열)는 문제가 없지만,
    // 웹폰트(Signika)가 아직 로딩 중일 때 캔버스와 실제 DOM 렌더링이 서로 다른
    // 시점에 폰트 로딩을 마칠 수 있어("캔버스는 아직 폴백폰트, DOM은 이미 로드완료"
    // 같은 순간차) 그 사이에 계산된 줄바꿈이 실제 렌더와 어긋날 수 있다.
    // → 폰트 로딩이 완전히 끝나는 시점(document.fonts.ready)에 한 번 더
    // 강제로 재줄바꿈해서, 그 시점 이후로는 폰트 로딩 타이밍 오차가 남지 않게 한다.
    try {
      document.fonts?.ready?.then(() => this._repaginateForCurrentWidth?.());
    } catch (_err) {
      // document.fonts 미지원 등 극히 예외적인 환경 — 무시하고 진행.
    }

    // render()가 아직 한 번도 실행되지 않았다면, 저장된 상태가 "아무도 없음"과
    // 동일하더라도 최초 1회는 반드시 render()를 실행해야 한다. theatre.html
    // 템플릿 안에 <style> 태그가 함께 있어서, render()가 호출되지 않으면
    // CSS 자체가 DOM에 삽입되지 않기 때문이다(새로고침 후 스타일이 안 먹는
    // 문제의 원인). _applyState()의 "상태 동일하면 스킵" 최적화가 이 최초
    // 렌더링까지 건너뛰지 않도록 별도로 추적한다.
    this._hasRenderedOnce = false;

    this._initDOM();
  }

  _initDOM() {
    let container = document.getElementById("custom-theatre-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "custom-theatre-container";

      // #hud의 조상 요소 중 하나가 캔버스 줌/패닝용 CSS transform을 갖고 있으면,
      // position:fixed의 기준점이 뷰포트가 아니라 그 조상 요소로 바뀌어버려서
      // 화면 밖(캔버스 전체 크기 기준 좌표)으로 밀려납니다.
      // 팝업/사이드바 파괴 버그는 Application(popOut:false) 사용 시 문제였고,
      // 여기서는 순수 DOM만 붙이므로 document.body에 직접 부착해도 안전합니다.
      document.body.appendChild(container);
    }
    this.element = container;
    this._restoreLocalPosition();
    this._applyLocalLayout();
    this._applyHudLayerSetting();
    this._setupDragAndEvents();
  }

  /**
   * 모듈 설정("hudLayerMode", client 스코프)에 따라 HUD 컨테이너의 z-index를
   * 다른 Foundry UI보다 앞/뒤로 전환한다. 맵시트/타일 등 캔버스 콘텐츠보다는
   * 항상 앞에 오도록 HUD_Z_INDEX_BEHIND 값을 사용한다("뒤로" 모드에서도).
   */
  _applyHudLayerSetting() {
    if (!this.element) return;
    let mode = "top";
    try {
      mode = game.settings.get(MODULE_ID, "hudLayerMode") ?? "top";
    } catch (_err) {
      // 설정이 아직 등록되지 않은 극초기 타이밍이면 기본값(top)을 사용한다.
    }
    const zIndex = mode === "behind" ? HUD_Z_INDEX_BEHIND : HUD_Z_INDEX_TOP;
    this.element.style.setProperty("--ctp-hud-z-index", String(zIndex));
  }

  /**
   * 슬롯 데이터 형태: { actorId, actorName, expressionImg } | null
   */
  async render() {
    if (!this.element) this._initDOM();

    const templatePath = `modules/${MODULE_ID}/src/templates/theatre.html`;
    const renderTemplateFn = getRenderTemplateFn();

    const htmlContent = await renderTemplateFn(templatePath, {
      slots: this.slots,
      activeText: this.currentText,
      dialogueText: this._visibleDialogueText(),
      speakerName: this._visibleDialogueSpeakerName(),
      speakerAppearance: this.currentSpeakerAppearance,
      speakerTypography: this._getLocalTypography(),
      speakerActorId: this.currentSpeakerActorId,
      minimized: this.minimized,
      positionLocked: this.positionLocked,
      hasDialogue: this._hasVisibleDialogue(),
      hasContent: this.slots.some((s) => s !== null) || !!this.currentText,
      isGM: game.user?.isGM ?? false,
      standingChannelBar: this._getStandingChannelBarContext()
    });

    this.element.innerHTML = htmlContent;
    this._applyLocalLayout();
    this._setupEvents();
    this._startTypewriter();
  }

  /**
   * [Phase 3] 스탠딩 박스 좌상단 채널 버튼 바에 필요한 데이터를 계산한다.
   * custom-chat-channels가 없거나 비활성이면 null을 반환해 템플릿이 버튼 자체를 그리지 않는다.
   */
  _getStandingChannelBarContext() {
    const api = getChatChannelsApi();
    if (!api) return null;

    const eligibleIds = normalizeStandingEligibleChannels(
      game.settings.get(MODULE_ID, "standingEligibleChannels")
    );
    const myChannel = game.settings.get(MODULE_ID, "myStandingChannel") || "";
    const forcedChannelId = game.settings.get(MODULE_ID, "forcedChannelId") || "";

    const buttons = eligibleIds.map((channelId, index) => {
      // [버그 5] "메인"은 내부 식별자(STANDING_MAIN_CHANNEL_ID)로 저장되어 있고 chat-channels의
      // 정식 채널 데이터가 아니므로 api.getChannelById로는 조회할 수 없다 — 이름/참여 여부를
      // 여기서 직접 구성한다. 메인은 항상 존재하고 항상 "참여 중"으로 간주한다(비활성화 제외).
      const isMain = channelId === STANDING_MAIN_CHANNEL_ID;
      const channel = isMain ? { name: STANDING_MAIN_CHANNEL_LABEL } : api.getChannelById(channelId);
      // GM이 지정한 뒤 삭제된 채널일 수 있음 — 이름을 못 찾으면 버튼 자체를 그리지 않는다.
      if (!channel) return null;
      return {
        id: channelId,
        slotNumber: index + 1, // 표시용이 아니라 내부 순서 참고용 — HUD에는 절대 노출하지 않는다(확정 원칙).
        name: channel.name,
        displayName: truncateStandingChannelName(channel.name), // [4장] 버튼에는 슬롯 번호 대신 이 말줄임 이름을 표시
        active: myChannel === channelId,
        disabled: isMain ? false : !api.isUserInChannel(channelId),
        forced: forcedChannelId === channelId
      };
    }).filter(Boolean);

    if (!buttons.length && !game.user?.isGM) return null; // 플레이어에게는 빈 바를 보여줄 이유가 없다.

    return { buttons, isGM: game.user?.isGM ?? false };
  }

  _setupEvents() {
    const minimizeBtn = this.element.querySelector("#theatre-minimize-btn");
    if (minimizeBtn) {
      // 닫기(전체 삭제) 대신 최소화/펼치기 토글로 변경.
      // 완전 초기화는 GM 매니저의 "전체 초기화" 버튼이 담당.
      minimizeBtn.onclick = () => this._toggleMinimizedAroundButton();
    }

    const lockBtn = this.element.querySelector("#theatre-lock-btn");
    if (lockBtn) {
      lockBtn.onclick = () => {
        this.positionLocked = !this.positionLocked;
        localStorage.setItem(LOCAL_LOCK_KEY, String(this.positionLocked));
        this.render();
      };
    }

    // GM 전용: 잠기지 않은 슬롯의 스탠딩만 전부 비움 (대사창/창 자체는 유지).
    const resetStandingsBtn = this.element.querySelector("#theatre-reset-standings-btn");
    if (resetStandingsBtn) {
      resetStandingsBtn.onclick = () => {
        if (!game.user?.isGM) return; // 템플릿에서 이미 GM에게만 렌더되지만, 방어적으로 한 번 더 확인.
        this.clearAllStandings();
      };
    }

    const managerBtn = this.element.querySelector("#theatre-manager-btn");
    if (managerBtn) {
      managerBtn.onclick = () => game.modules.get(MODULE_ID)?.api?.openManager?.();
      // [표정 선택 도우미] 좌측 토큰 컨트롤의 무대 매니저 아이콘과 동일한 우클릭 진입점을
      // 스탠딩 텍스트 박스 HUD 쪽 무대 매니저 아이콘에도 추가한다. main.js가 ready 단계에서
      // 등록해 둔 module api(openExpressionPicker)를 그대로 재사용하므로 여기서는 별도 import
      // 없이 호출만 하면 된다(브라우저 기본 우클릭 메뉴는 막는다).
      managerBtn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        game.modules.get(MODULE_ID)?.api?.openExpressionPicker?.();
      });
    }

    const settingsBtn = this.element.querySelector("#theatre-settings-btn");
    if (settingsBtn) {
      settingsBtn.onclick = () => this._openModuleSettings();
    }

    const previousBtn = this.element.querySelector("#theatre-previous-btn");
    if (previousBtn) previousBtn.onclick = () => this._showPreviousDialogue();

    const nextBtn = this.element.querySelector("#theatre-next-btn");
    if (nextBtn) nextBtn.onclick = () => this._advanceDialogue();

    const jumpLatestBtn = this.element.querySelector("#theatre-jump-latest-btn");
    if (jumpLatestBtn) jumpLatestBtn.onclick = () => this._jumpToLatestDialogue();

    const dialogueContent = this.element.querySelector("#theatre-dialogue-content");
    if (dialogueContent) dialogueContent.onclick = () => this._advanceDialogue();

    // [Phase 3] 스탠딩 채널 버튼: 클릭(내 스탠딩 채널 선택) / 더블클릭(GM 전용 강제 전환)
    this.element.querySelectorAll(".ctp-standing-channel-btn").forEach((btn) => {
      const channelId = btn.dataset.channelId;
      if (!channelId) return;
      btn.onclick = () => this._onStandingChannelClick(channelId);
      if (game.user?.isGM) btn.ondblclick = () => this._onStandingChannelDblClick(channelId);
    });

    const standingChannelConfigBtn = this.element.querySelector("#theatre-standing-channel-config-btn");
    if (standingChannelConfigBtn) {
      standingChannelConfigBtn.onclick = () => this._openStandingChannelConfig();
    }

    // [가시성 개선] GM 전용: 채널 버튼 바 아무 곳이나 우클릭하면 주목(강제 전환) 즉시 해제.
    // 개별 버튼이 아니라 바 컨테이너 전체에 걸어서, 어느 버튼 위에서 우클릭해도(빈 여백
    // 포함) 동일하게 동작한다.
    const standingChannelBar = this.element.querySelector(".ctp-standing-channel-bar");
    if (standingChannelBar && game.user?.isGM) {
      standingChannelBar.oncontextmenu = (event) => {
        event.preventDefault();
        this._clearForcedStandingChannel();
      };
    }
  }

  /** [가시성 개선] GM 전용: 어느 채널이 강제 중이든 상관없이 주목(강제 전환)을 즉시 해제한다. */
  async _clearForcedStandingChannel() {
    if (!game.user?.isGM) return;
    const current = game.settings.get(MODULE_ID, "forcedChannelId") || "";
    if (!current) return; // 이미 꺼져 있으면 아무것도 하지 않는다.
    await game.settings.set(MODULE_ID, "forcedChannelId", "");
    game.socket.emit(SOCKET_NAME, { type: "FORCE_STANDING_CHANNEL", payload: { channelId: "" } });
    // 해제되어도 각자 보고 있던 탭은 그대로 유지된다(4장 확정 사항) — 대사/스탠딩 내용은
    // 그대로이고 버튼 바의 forced 표시만 사라지면 되므로 단순 render()로 충분하다.
    this.render();
  }

  /**
   * [Phase 3] 스탠딩 채널 버튼 클릭: 이 버튼의 채널로 내 채팅 탭을 전환하고,
   * 스탠딩 박스가 튜닝할 채널도 함께 맞춘다(둘을 분리해서 조작할 이유가 없어 항상 같이 움직인다).
   * 참여하지 않은 채널(비활성 표시)은 애초에 클릭해도 아무 일도 일어나지 않는다.
   */
  async _onStandingChannelClick(channelId) {
    const api = getChatChannelsApi();
    if (!api) return;
    // [버그 5] channelId는 슬롯 설정에 저장된 내부 식별자(메인이면 STANDING_MAIN_CHANNEL_ID)다.
    // chat-channels API를 실제로 호출할 때만 toRealChannelId로 실제 채널 id(메인은 "")로
    // 변환한다. 메인은 항상 참여 중으로 간주해 isUserInChannel 검사를 건너뛴다.
    const isMain = channelId === STANDING_MAIN_CHANNEL_ID;
    if (!isMain && !api.isUserInChannel(channelId)) return;
    await api.setActiveChannel(toRealChannelId(channelId));
    await game.settings.set(MODULE_ID, "myStandingChannel", channelId);
    // [버그 1] myStandingChannel만 바꾸고 render()만 부르면, 그 render()는 채널 버튼 바
    // UI만 다시 그릴 뿐 실제 스탠딩/대사창 내용(this.slots/this.currentText)은 건드리지
    // 않아 새 메시지가 오기 전까지 이전 채널 화면이 그대로 남아있었다. 전환 대상 채널의
    // 마지막 대사를 여기서 즉시 복원한다.
    // [버그 2] restoreStandingChannelDisplay가 실제로 뭔가 반영했다면 그 안에서 이미
    // render()까지 끝난 상태다. 여기서 또 render()를 부르면 렌더가 겹쳐 화면이 깨지므로
    // (스탠딩 박스가 꺼져 보이던 원인), 복원한 게 없을 때(=버튼 바 활성 표시만 갱신하면
    // 되는 경우)만 render()를 부른다.
    const restored = await this.restoreStandingChannelDisplay(channelId);
    if (!restored) this.render();
  }

  /**
   * [Phase 3] GM 더블클릭: 이 채널로 전원을 강제 전환한다. 이미 이 채널로 강제 중이면
   * 다시 더블클릭 시 해제한다 — 해제되어도 각자 보고 있던 탭은 그대로 유지된다
   * (인계 문서 4장 확정 사항: "직전 개인 선택 복귀"가 아님).
   */
  async _onStandingChannelDblClick(channelId) {
    if (!game.user?.isGM) return;
    const current = game.settings.get(MODULE_ID, "forcedChannelId") || "";
    const next = current === channelId ? "" : channelId;
    await game.settings.set(MODULE_ID, "forcedChannelId", next);
    game.socket.emit(SOCKET_NAME, { type: "FORCE_STANDING_CHANNEL", payload: { channelId: next } });
    // GM 자신의 화면도 소켓 자기 자신에게는 도착하지 않으므로 로컬에서 직접 반영한다.
    if (next) {
      const api = getChatChannelsApi();
      // [버그 5] next도 내부 식별자다. 메인은 항상 참여 중으로 간주한다.
      const isMain = next === STANDING_MAIN_CHANNEL_ID;
      if (api && (isMain || api.isUserInChannel(next))) {
        await api.setActiveChannel(toRealChannelId(next));
        await game.settings.set(MODULE_ID, "myStandingChannel", next);
        // [버그 1] 다른 클라이언트는 main.js의 applyForcedStandingChannel(소켓/updateSetting
        // 경로)에서 동일하게 복원되지만, GM 자신의 화면에는 소켓이 되돌아오지 않으므로
        // 여기서도 직접 호출해야 한다.
        await this.restoreStandingChannelDisplay(next);
      }
    }
    // [가시성 개선, 버그 수정] loadChannelDisplay(restoreStandingChannelDisplay)는 실제로
    // 화면을 다시 그렸는지와 무관하게 항상 true를 반환한다(_applyState 안의 "내용 동일하면
    // 렌더 스킵" 최적화가 forcedChannelId 같은 "버튼 바 전용" 값의 변화까지는 알지 못해서다).
    // 그래서 예전엔 그 반환값을 믿고 "restored===true면 render() 생략"했는데, GM이 이미
    // 보고 있던 채널을 다시 더블클릭해 강제 전환만 켜는 경우(내용은 그대로, forced만 바뀜)
    // 내부 render()가 스킵돼버려 배경 채움이 즉시 안 보이고, 다른 탭을 눌러야만(그 시점엔
    // 내용도 달라지니 스킵이 안 걸림) 뒤늦게 나타났었다. 이 지점은 모든 await가 끝난 뒤라
    // [버그 2]가 우려했던 비동기 렌더 경쟁 상황이 아니므로, 버튼 바를 확실히 최신 상태로
    // 그리기 위해 매번 한 번 더 render()를 부른다(이미 막 그려졌어도 동일 내용 재렌더라
    // 부작용 없음).
    this.render();
  }

  /**
   * [버그 1] 채널 메시지 하나를 받아 대사창/스탠딩에 반영한다. 실시간 채널 메시지 감지
   * (main.js의 customChatChannelsMessageCreated 리스너)와 스탠딩 채널 전환 시 "마지막
   * 대사" 즉시 복원(restoreStandingChannelDisplay) 양쪽이 완전히 동일한 이 메서드를
   * 공유하므로, 두 경로의 결과가 항상 일치한다. emit은 항상 false(=applyLocalOnly)로
   * 고정한다 — 채널 대사를 world 상태로 브로드캐스트/영구저장하면 그 채널에 없는
   * 플레이어의 화면에도 스탠딩 HUD가 갱신되어 내용이 새어나가기 때문이다.
   *
   * [버그 2] speakAs/speakAsAlias는 내부적으로 applyLocalOnly → _applyState → render()까지
   * 이미 끝마친다. 호출부가 이 사실을 모르고 뒤이어 또 render()를 부르면(예: 채널 전환
   * 직후) 렌더가 두 번 겹치고, 그 사이에 _applyState가 GM 상태를 world에 persist하면서
   * 스스로 되돌아오는 updateSetting → renderWithData 렌더까지 얽혀 화면이 깨지는(스탠딩
   * 박스가 사라지는) 현상이 있었다. 그래서 "실제로 반영해서 렌더까지 마쳤는지"를
   * boolean으로 반환해, 호출부가 중복 render()를 피할 수 있게 한다.
   * @returns {Promise<boolean>} 실제로 speakAs/speakAsAlias를 호출해 반영했으면 true.
   */
  async applyChannelMessage(message, channelId = this.currentChannelId) {
    const text = getTheatreChatText(message);
    if (!text || text.startsWith("@")) return false;

    const actorId = message.speaker?.actor;
    if (actorId) {
      const actor = game.actors.get(actorId);
      if (actor) {
        const alias = message.speaker?.alias?.trim() || "";
        const displayName = alias && alias !== actor.name ? alias : null;
        await this.speakAs(actor, text, null, { emit: false, displayName, channelId });
        return true;
      }
    }

    const alias = message.speaker?.alias?.trim() || "";
    await this.speakAsAlias(alias, text, { emit: false, channelId });
    return true;
  }

  /**
   * [Phase 4] 구버전 restoreStandingChannelDisplay(그 채널의 "마지막 채팅 메시지"를 조회해
   * 재구성하던 방식)를 대체한다. 채널별 영구 상태(currentState 맵) 자체가 이제 존재하므로
   * 메시지 재구성이 필요 없다 — loadChannelDisplay로 그대로 위임한다(인계 문서 5장 5번:
   * "채널별 마지막 시각 상태 캐시는 더 이상 필요 없어질 가능성이 높다"에 따라 정리함).
   * @returns {Promise<boolean>}
   */
  async restoreStandingChannelDisplay(channelId) {
    return this.loadChannelDisplay(channelId);
  }

  /** [Phase 3] GM 전용: 스탠딩 버튼에 노출할 채널(최대 3개)을 고르는 설정창을 연다. */
  async _openStandingChannelConfig() {
    if (!game.user?.isGM) return;
    const api = getChatChannelsApi();
    if (!api) return;

    const { StandingChannelConfigApp } = await import("./StandingChannelConfigApp.js");
    StandingChannelConfigApp.open();
  }

  /**
   * [모듈 설정] 톱니바퀴 버튼: Foundry 기본 설정 시트를 이 모듈의 설정 카테고리가
   * 보이는 상태로 바로 연다.
   *
   * V13의 SettingsConfig는 ApplicationV2 기반 CategoryBrowser라 카테고리(=모듈별 탭)
   * 옵션 이름이 V1과 달리 `tab`이 아니라 `initialCategory`다. 다만 game.settings.sheet는
   * Foundry가 한 번 만들어두고 계속 재사용하는 싱글턴이라, 예전에 다른 탭(예: 코어 설정)을
   * 보고 있던 상태로 이미 렌더된 적이 있으면 `initialCategory`를 다시 넘겨도 "처음 열 때만
   * 쓰는 기본값"이라 무시되고 마지막으로 보고 있던 탭이 그대로 유지된다(실사용 중 확인된
   * 원인 — 톱니바퀴를 눌러도 코어 설정이 뜨던 문제). 그래서 render 완료를 기다린 뒤
   * changeTab()으로 이 모듈의 카테고리 탭을 명시적으로 한 번 더 활성화해 확실히 보정한다.
   * (탭 그룹 id는 SettingsConfig가 쓰는 "category".)
   */
  async _openModuleSettings() {
    const sheet = game.settings.sheet;
    try {
      await sheet.render(true, { initialCategory: MODULE_ID });
    } catch (err) {
      console.error(`${MODULE_ID} 모듈 설정 창을 여는 데 실패했습니다:`, err);
      ui.notifications?.error("모듈 설정 창을 여는 중 오류가 발생했습니다. 콘솔(F12)을 확인해주세요.");
      return;
    }
    try {
      sheet.changeTab?.(MODULE_ID, "category", { force: true });
    } catch (err) {
      // 탭 전환 보정이 실패해도 설정 창 자체는 이미 열려 있으므로 조용히 무시한다.
      console.error(`${MODULE_ID} 모듈 설정 탭으로 전환하는 데 실패했습니다:`, err);
    }
  }

  /**
   * 최소화/펼치기 토글을 "최소화 버튼 자체의 화면 좌표"를 중심으로 접히도록 만든다.
   * - 배경: 컨테이너는 bottom(또는 드래그 후에는 top) 기준으로 고정되는데, 최소화 시
   *   스탠딩+대사창 영역(.theatre-body)이 사라지면서 컨테이너 전체 높이가 줄어든다.
   *   그러면 고정된 기준선(top 또는 bottom) 반대쪽으로 버튼 줄이 확 튀는 것처럼 보인다
   *   (특히 한 번이라도 드래그해 top 기준으로 바뀐 경우, 버튼이 위로 솟구쳐 보임).
   * - 해결: 토글 직전에 최소화 버튼의 실제 화면 좌표(getBoundingClientRect)를 기억해두고,
   *   렌더링이 끝난 뒤 같은 버튼의 새 좌표와 비교해서 그 차이만큼 컨테이너 위치를
   *   보정한다. 결과적으로 버튼은 화면상 같은 자리에 그대로 있고, 그 buttons을 중심으로
   *   위/아래에서 본문 영역만 접히거나 펼쳐지는 것처럼 보인다.
   * - 드래그 로직과 동일하게, 보정 시 transform은 제거하고 left/top을 명시적인 px 값으로
   *   전환한다(bottom은 auto). 이 위치는 드래그했을 때와 마찬가지로 저장되어, 다음
   *   최소화/펼치기나 새로고침에도 버튼 위치가 유지된다.
   */
  async _toggleMinimizedAroundButton() {
    const beforeBtn = this.element.querySelector("#theatre-minimize-btn");
    const beforeRect = beforeBtn ? beforeBtn.getBoundingClientRect() : null;

    this.minimized = !this.minimized;
    await this.render();

    if (!beforeRect) return;
    const afterBtn = this.element.querySelector("#theatre-minimize-btn");
    if (!afterBtn) return;
    const afterRect = afterBtn.getBoundingClientRect();
    const dx = beforeRect.left - afterRect.left;
    const dy = beforeRect.top - afterRect.top;
    if (dx === 0 && dy === 0) return;

    const containerRect = this.element.getBoundingClientRect();
    const newLeft = containerRect.left + dx;
    const newTop = containerRect.top + dy;
    this.element.style.transform = "none";
    this.element.style.left = `${newLeft}px`;
    this.element.style.top = `${newTop}px`;
    this.element.style.bottom = "auto";
    this._saveLocalPosition(newLeft, newTop);
  }

  _setupDragAndEvents() {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    this.element.addEventListener("mousedown", (e) => {
      const handle = e.target.closest("#theatre-drag-handle");
      const resizeHandle = e.target.closest("#theatre-resize-handle");
      if ((!handle && !resizeHandle) || this.positionLocked) return;

      e.preventDefault();
      if (resizeHandle) {
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = this.element.getBoundingClientRect();
        const startWidth = rect.width;
        const startTextboxHeight = this.hudLayout.textboxHeight;

        // 대사창 상단을 기준점으로 고정해 세로 크기를 바꿔도 무대와
        // 대사창의 접점이 위로 밀리지 않도록 한다.
        this.element.style.transform = "none";
        this.element.style.left = `${rect.left}px`;
        this.element.style.top = `${rect.top}px`;
        this.element.style.bottom = "auto";

        // 드래그 중 매 mousemove마다 대사 줄바꿈을 다시 계산하면 픽셀 측정(canvas.measureText)이
        // 프레임당 여러 번 겹쳐 돌 수 있어, requestAnimationFrame으로 프레임당 한 번만 반영한다.
        let repaginateRafId = null;
        const scheduleRepaginate = () => {
          if (repaginateRafId !== null) return;
          repaginateRafId = requestAnimationFrame(() => {
            repaginateRafId = null;
            this._repaginateForCurrentWidth();
          });
        };

        const onMouseMove = (moveEvent) => {
          this.hudLayout.width = this._clampHudWidth(startWidth + (moveEvent.clientX - startX));
          this.hudLayout.textboxHeight = this._clampTextboxHeight(startTextboxHeight + (moveEvent.clientY - startY));
          this._applyLocalLayout();
          scheduleRepaginate();
        };

        const onMouseUp = () => {
          if (repaginateRafId !== null) {
            cancelAnimationFrame(repaginateRafId);
            repaginateRafId = null;
          }
          this._repaginateForCurrentWidth(); // 마지막 프레임 폭까지 확실히 반영.
          this._saveLocalLayout();
          this._saveLocalPosition(rect.left, rect.top);
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        return;
      }

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = this.element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      this.element.style.transform = "none";
      this.element.style.left = `${initialLeft}px`;
      this.element.style.top = `${initialTop}px`;
      this.element.style.bottom = "auto";

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        this.element.style.left = `${initialLeft + dx}px`;
        this.element.style.top = `${initialTop + dy}px`;
      };

      const onMouseUp = (upEvent) => {
        isDragging = false;
        this._saveLocalPosition(initialLeft + upEvent.clientX - startX, initialTop + upEvent.clientY - startY);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  _restoreLocalPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_POSITION_KEY));
      if (!Number.isFinite(saved?.left) || !Number.isFinite(saved?.top)) return;
      this.element.style.transform = "none";
      this.element.style.left = `${saved.left}px`;
      this.element.style.top = `${saved.top}px`;
      this.element.style.bottom = "auto";
    } catch (_err) {
      // 저장값이 없거나 손상된 경우 기본 중앙 하단 위치를 사용한다.
    }
  }

  _saveLocalPosition(left, top) {
    localStorage.setItem(LOCAL_POSITION_KEY, JSON.stringify({ left, top }));
  }

  /**
   * 저장된 위치값(localStorage)을 지우고, HUD를 화면 정중앙(top 50% / left 50% /
   * translate(-50%, -50%))으로 이동시킨다. 매크로바와 겹치던 기존 하단 고정
   * 위치(bottom 30px) 대신 화면 어디와도 겹치지 않는 정중앙을 기본 초기화
   * 지점으로 사용한다.
   *
   * 주의: 이 동작은 "초기화" 버튼을 눌렀을 때만 적용된다. 저장된 위치가 아예
   * 없는 신규 사용자(한 번도 드래그한 적 없는 상태)의 기본 위치는 이 함수와
   * 무관하게 theatre.html/theatre.css의 #custom-theatre-container 기본 CSS
   * (bottom 30px / left 50%)를 그대로 따르며, 여기서는 변경하지 않는다.
   * 레이아웃 크기·잠금 여부 등 다른 설정도 건드리지 않는다. 이 함수를 호출한
   * 클라이언트(브라우저)에만 적용된다.
   */
  resetLocalPosition() {
    localStorage.removeItem(LOCAL_POSITION_KEY);
    if (!this.element) return;
    this.element.style.left = "50%";
    this.element.style.top = "50%";
    this.element.style.bottom = "auto";
    this.element.style.transform = "translate(-50%, -50%)";
  }

  _loadLocalLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_LAYOUT_KEY));
      return {
        width: this._clampHudWidth(saved?.width),
        textboxHeight: this._clampTextboxHeight(saved?.textboxHeight),
        globalStandingScale: this._clampGlobalStandingScale(saved?.globalStandingScale),
        standingSpacing: this._clampStandingSpacing(saved?.standingSpacing)
      };
    } catch (_err) {
      return {
        width: DEFAULT_HUD_WIDTH,
        textboxHeight: DEFAULT_TEXTBOX_HEIGHT,
        globalStandingScale: DEFAULT_GLOBAL_STANDING_SCALE,
        standingSpacing: DEFAULT_STANDING_SPACING
      };
    }
  }

  _clampHudWidth(width) {
    const maxWidth = Math.max(480, window.innerWidth - 40);
    const numericWidth = Number(width);
    const fallback = Math.min(DEFAULT_HUD_WIDTH, maxWidth);
    return Number.isFinite(numericWidth) ? Math.min(maxWidth, Math.max(480, numericWidth)) : fallback;
  }

  _clampTextboxHeight(height) {
    const numericHeight = Number(height);
    return Number.isFinite(numericHeight)
      ? Math.min(420, Math.max(120, numericHeight)) // 세로는 4줄 고정 설계라 기존 상한(420)으로 되돌림
      : DEFAULT_TEXTBOX_HEIGHT;
  }

  _clampGlobalStandingScale(scale) {
    const numericScale = Number(scale);
    return Number.isFinite(numericScale)
      ? Math.min(2, Math.max(0.5, numericScale))
      : DEFAULT_GLOBAL_STANDING_SCALE;
  }

  _clampStandingSpacing(spacing) {
    const numericSpacing = Number(spacing);
    return Number.isFinite(numericSpacing)
      ? Math.min(1.4, Math.max(0.5, numericSpacing))
      : DEFAULT_STANDING_SPACING;
  }

  _applyLocalLayout() {
    if (!this.element) return;
    this.hudLayout.width = this._clampHudWidth(this.hudLayout.width);
    this.hudLayout.textboxHeight = this._clampTextboxHeight(this.hudLayout.textboxHeight);
    this.hudLayout.globalStandingScale = this._clampGlobalStandingScale(this.hudLayout.globalStandingScale);
    this.hudLayout.standingSpacing = this._clampStandingSpacing(this.hudLayout.standingSpacing);
    // 4인 기준 슬롯 간 간격(%): 인원수가 줄어도 이 간격은 그대로 유지한 채,
    // 채워진 슬롯끼리만 중앙(50%) 기준 좌우 대칭이 되도록 재배치한다.
    // - 빈 슬롯은 무시하고 압축한다(예: 1·4번 슬롯만 채워져 있으면 둘이 붙어서 중앙에 모임).
    // - 배치 순서는 슬롯 인덱스(1→2→3→4) 순서를 그대로 따른다.
    // - 인원수 변화(등장/퇴장) 시 순간 이동으로만 반영되며 별도의 이동 애니메이션은 없다.
    const SLOT_STEP_PERCENT = 25;
    const filledSlotIndices = this.slots
      .map((slot, index) => (slot ? index : null))
      .filter((index) => index !== null);
    const filledCount = filledSlotIndices.length;
    const compactOffsets = filledSlotIndices.map((_slotIndex, orderInFilled) =>
      (orderInFilled - (filledCount - 1) / 2) * SLOT_STEP_PERCENT
    );
    const offsetBySlotIndex = [0, 0, 0, 0];
    filledSlotIndices.forEach((slotIndex, orderInFilled) => {
      offsetBySlotIndex[slotIndex] = compactOffsets[orderInFilled];
    });

    const slotPositions = offsetBySlotIndex.map((offset) => 50 + (offset * this.hudLayout.standingSpacing));
    this.element.style.setProperty("--hud-width", `${this.hudLayout.width}px`);
    this.element.style.setProperty("--textbox-height", `${this.hudLayout.textboxHeight}px`);
    this.element.style.setProperty("--global-standing-scale", String(this.hudLayout.globalStandingScale));
    slotPositions.forEach((position, index) => this.element.style.setProperty(`--slot-${index + 1}-left`, `${position}%`));
  }

  _saveLocalLayout() {
    localStorage.setItem(LOCAL_LAYOUT_KEY, JSON.stringify(this.hudLayout));
  }

  getLocalGlobalStandingScale() {
    return this._clampGlobalStandingScale(this.hudLayout.globalStandingScale);
  }

  getLocalStandingSpacing() {
    return this._clampStandingSpacing(this.hudLayout.standingSpacing);
  }

  setLocalStandingSettings(scale, spacing) {
    this.hudLayout.globalStandingScale = this._clampGlobalStandingScale(scale);
    this.hudLayout.standingSpacing = this._clampStandingSpacing(spacing);
    this._saveLocalLayout();
  }

  _getLocalTypography() {
    const fallback = { nameFontSize: DEFAULT_APPEARANCE.nameFontSize, chatFontSize: DEFAULT_APPEARANCE.chatFontSize };
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_TYPOGRAPHY_KEY));
      const value = saved || {};
      const clamp = (input, defaultValue, min, max) => {
        const numeric = Number(input);
        return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : defaultValue;
      };
      return {
        nameFontSize: clamp(value.nameFontSize, fallback.nameFontSize, 12, 32),
        chatFontSize: clamp(value.chatFontSize, fallback.chatFontSize, 14, 30)
      };
    } catch (_err) {
      return fallback;
    }
  }

  refreshLocalTypography() {
    return this.render();
  }

  _clearDialogueTimers() {
    clearTimeout(this._dialogue.typingTimer);
    clearTimeout(this._dialogue.autoAdvanceTimer);
    this._dialogue.typingTimer = null;
    this._dialogue.autoAdvanceTimer = null;
    this._dialogue.awaitingAdvance = false;
  }

  /**
   * [0안: A] _setDialogue() 직후(페이지가 막 새로 생성된 시점)에만 호출한다.
   * 마지막 페이지로 바로 이동시키고 그 페이지 전체를 이미 다 타이핑된 것으로 표시해,
   * render() → _startTypewriter()가 처음부터 다시 타이핑하지 않고(manualNavigation
   * 체크에 걸려 즉시 return) 완성된 상태로 바로 그려지게 한다.
   */
  _revealDialogueImmediately() {
    if (!this._dialogue.pages.length) return;
    this._clearDialogueTimers();
    this._dialogue.pageIndex = this._dialogue.pages.length - 1;
    this._dialogue.typedChars = Array.from(this._dialogue.pages[this._dialogue.pageIndex]).length;
    this._dialogue.manualNavigation = true;
    this._dialogue.awaitingAdvance = false;
  }

  _makeDialogueSourceKey(text, speakerName, speakerActorId) {
    return JSON.stringify([text || "", speakerName || "", speakerActorId || ""]);
  }

  /**
   * 현재 대사가 아직 "다 읽히지 않은" 상태인지 판단한다.
   * - 마지막 페이지에 도달하지 않았거나, 마지막 페이지의 타이핑이 아직 끝나지 않았으면 true.
   * - 대사가 아예 없으면(빈 상태) false.
   * 히스토리(‹로 과거 대사 열람 중)는 실제 진행 상태에 영향을 주지 않으므로 판단에서 제외한다.
   */
  _isDialogueInProgress() {
    // 최소화 상태에서는 대사창이 보이지 않으므로 대기시킬 이유가 없다.
    if (this.minimized) return false;
    if (!this._dialogue.pages.length) return false;
    // 마지막 페이지 타이핑은 끝났지만 다음으로 넘어가기 전 대기시간(AUTO_ADVANCE_DELAY_MS) 중이면,
    // 아직 "다 읽은" 상태로 취급하지 않는다. (그래야 이 대기 중에 들어온 새 메시지도 큐잉된다.)
    if (this._dialogue.awaitingAdvance) return true;
    const lastPageIndex = this._dialogue.pages.length - 1;
    if (this._dialogue.pageIndex < lastPageIndex) return true;
    const lastPageLength = Array.from(this._dialogue.pages[lastPageIndex] || "").length;
    return this._dialogue.typedChars < lastPageLength;
  }

  /**
   * 대기 중이던 다음 상태가 있으면 지금 적용한다.
   * 현재 대사의 마지막 페이지 타이핑이 끝난 시점(자동/수동 모두)에 호출된다.
   */
  _applyPendingStateIfAny() {
    if (!this._pendingState) return;
    const pending = this._pendingState;
    this._pendingState = null;
    this._applyState(
      pending.newSlots,
      pending.text,
      pending.speakerName,
      pending.speakerActorId,
      pending.speakerAppearance,
      pending.lockedSlots,
      pending.persist,
      pending.sourceUpdatedAt ?? null
    ).catch((err) => console.error("[Custom Theatre] 대기 중이던 대사 적용 실패:", err));
  }

  _setDialogue(text, speakerName, speakerActorId) {
    const sourceKey = this._makeDialogueSourceKey(text, speakerName, speakerActorId);
    if (sourceKey === this._dialogue.sourceKey) return;

    if (this._dialogue.pages.length && this._dialogue.sourceKey) {
      const previousPages = this._dialogue.pages.map((page) => ({
        text: page,
        speakerName: this._dialogue.speakerName
      }));
      this._dialogueHistory = [...previousPages, ...this._dialogueHistory].slice(0, MAX_HISTORY_PAGES);
    }

    this._clearDialogueTimers();
    this._dialogue = {
      sourceKey,
      speakerName: speakerName || "",
      rawText: text || "", // 리사이즈 시 새 폭으로 다시 흘려보낼 때(_repaginateForCurrentWidth) 원본을 다시 써야 해서 보관.
      pages: this._paginateDialogue(text || ""),
      pageIndex: 0,
      typedChars: 0,
      historyIndex: -1,
      manualNavigation: false,
      awaitingAdvance: false,
      typingTimer: null,
      autoAdvanceTimer: null
    };
  }

  _paginateDialogue(text) {
    if (!text) return [];
    const availableWidth = this._getAvailableTextWidth();
    const fontSizePx = this._getLocalTypography().chatFontSize;
    const lines = [];

    // v1.7.26에서 "전체 문자열 measureText"로 폭 오차 문제는 해결됐지만, 문자 단위로
    // 아무 지점에서나 끊는 방식은 CSS(.textbox-content { word-break: keep-all })와
    // 어긋난다. keep-all은 "공백이 아닌 위치에서는 줄바꿈 금지"라 JS가 단어 중간에서
    // 끊어도 브라우저가 그 지점을 거부하고 앞쪽 공백까지 되돌려 다시 끊어버린다.
    // 그 결과가 연쇄적으로 누적되어 JS 계산 줄수보다 실제 렌더 줄수가 훨씬 많아지는
    // "줄바꿈 파편화"였다 (예: "부담 가" / "지 않습니다" 처럼 단어 중간 절단).
    // → CSS와 동일하게 "공백" 단위로만 줄을 끊는다. 다만 단어 하나가 그 자체로
    // availableWidth보다 넓은 극단적인 경우엔 CSS의 overflow-wrap: break-word와
    // 동일하게 그 단어만 문자 단위로 강제 분해해서 fallback한다.

    // DEBUG: 계속 유지 — 다음에 또 문제가 생기면 바로 원인 추적용으로 쓴다.
    const debugContentEl = this.element?.querySelector(".textbox-content");
    const debugBoxEl = this.element?.querySelector(".theatre-textbox");
    console.log("[theatre-linewrap-debug2] hudLayout.width:", this.hudLayout.width,
      "/ theatre-textbox clientWidth:", debugBoxEl?.clientWidth,
      "/ textbox-content clientWidth:", debugContentEl?.clientWidth,
      "/ 최종 availableWidth:", availableWidth,
      "/ font:", `${fontSizePx}px ${this._measuredFontFamily || FALLBACK_FONT_FAMILY}`);

    const measure = (s) => this._measureTextWidth(s, fontSizePx);

    // 폭을 초과하는 단어를 keep-all 예외 케이스(overflow-wrap: break-word)와 동일하게
    // 문자 단위로 강제 분해한다. 분해된 조각 중 마지막 조각만 호출부에서 다음 줄의
    // 시작으로 이어붙일 수 있도록 배열로 반환한다.
    const breakOversizedWord = (word) => {
      const pieces = [];
      let piece = "";
      for (const char of Array.from(word)) {
        const candidate = piece + char;
        if (piece && measure(candidate) > availableWidth) {
          pieces.push(piece);
          piece = char;
        } else {
          piece = candidate;
        }
      }
      pieces.push(piece);
      return pieces;
    };

    for (const rawLine of text.split("\n")) {
      // 사용자가 명시적으로 넣은 줄바꿈(\n)은 그대로 존중하고, 그 안에서만 공백 단위로 감싼다.
      const words = rawLine.split(" ");
      let line = "";
      for (const word of words) {
        if (word === "") {
          // 연속 공백 등으로 생긴 빈 단어는 건너뛴다 (줄 맨 앞에 공백이 들어가 들여쓰기처럼 보이는 것 방지).
          continue;
        }
        const candidate = line ? `${line} ${word}` : word;
        const candidateWidth = measure(candidate);

        if (candidateWidth <= availableWidth) {
          line = candidate;
          continue;
        }

        if (line) {
          console.log(`[theatre-linewrap-debug2] 줄 확정: "${line}" / 폭=${measure(line).toFixed(2)} / availableWidth=${availableWidth}`);
          lines.push(line);
          line = "";
        }

        // 단어 하나만으로도 폭을 넘으면 그 단어를 통째로 강제 분해한다.
        if (measure(word) > availableWidth) {
          const pieces = breakOversizedWord(word);
          for (let i = 0; i < pieces.length - 1; i++) {
            console.log(`[theatre-linewrap-debug2] 줄 확정(단어강제분해): "${pieces[i]}" / 폭=${measure(pieces[i]).toFixed(2)} / availableWidth=${availableWidth}`);
            lines.push(pieces[i]);
          }
          line = pieces[pieces.length - 1];
        } else {
          line = word;
        }
      }
      console.log(`[theatre-linewrap-debug2] 줄 확정(끝): "${line}" / 폭=${measure(line).toFixed(2)} / availableWidth=${availableWidth}`);
      lines.push(line);
    }

    const pages = [];
    for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
      pages.push(lines.slice(i, i + LINES_PER_PAGE).join("\n"));
    }
    return pages;
  }

  /**
   * 줄바꿈 폭 계산에 쓸 "실제로 텍스트가 그려지는" 가로 폭을 구한다.
   * 이전에는 this.hudLayout.width(저장된 상태값)에서 padding/border를 빼는 식으로
   * 계산했는데, 이 저장값이 실제 렌더된 DOM 폭과 어긋나는 경우(예: 컨테이너에 걸린
   * max-width: calc(100vw - 40px) 클램프로 실제 폭이 hudLayout.width보다 좁아지는 상황,
   * 리사이즈 직후 상태 동기화 지연 등)에는 JS가 실제보다 넓게 계산해서 CSS가 줄 끝을
   * 또 한 번 강제로 잘라내는(이중 줄바꿈) 원인이 됐다.
   * → 저장값을 신뢰하지 않고, 매번 .textbox-content의 실제 clientWidth를 직접 재서 쓴다.
   * (.textbox-content는 padding:0, box-sizing:border-box라 clientWidth 자체가 이미
   * "텍스트가 실제로 들어갈 수 있는 폭"이라 padding/border를 또 빼지 않아도 됨.)
   * 아직 한 번도 렌더되지 않아 DOM을 읽을 수 없는 극히 초반 상황에서만
   * hudLayout.width 기반 근사값으로 폴백한다.
   */
  _getAvailableTextWidth() {
    const contentEl = this.element?.querySelector(".textbox-content");
    if (contentEl && contentEl.clientWidth > 0) {
      return contentEl.clientWidth - TEXTBOX_SAFETY_MARGIN_PX;
    }
    return (
      this.hudLayout.width -
      TEXTBOX_HORIZONTAL_PADDING_PX * 2 -
      TEXTBOX_BORDER_PX * 2 -
      TEXTBOX_SAFETY_MARGIN_PX
    );
  }

  /**
   * 줄바꿈 폭 측정을 canvas 2D measureText()가 아니라, 화면 밖에 숨겨둔 실제
   * DOM span으로 한다. (v1.7.27까지는 canvas였음.)
   *
   * 이유: Canvas 2D의 텍스트 렌더링 엔진과, 브라우저가 .textbox-content를
   * 실제로 레이아웃할 때 쓰는 텍스트 렌더링 엔진은 서로 다른 서브시스템이다.
   * font-family/size가 같아도 커닝 처리, 서브픽셀 반올림, 글리프 셰이핑
   * 방식이 미묘하게 달라서 몇 px씩 어긋나는 경우가 있었다 — 특히 줄 끝
   * 여백이 몇 px밖에 안 남는 경계선 케이스에서, 이 오차가
   * TEXTBOX_SAFETY_MARGIN_PX(6px)를 넘어서면 "JS는 안 넘는다고 계산했는데
   * 실제 화면에서는 넘어가서 줄이 밀리는" 문제가 생겼다 (한글+구두점+숫자가
   * 섞이면 오차가 더 커지는 경향이 있어 "가끔"만 재현됐다).
   *
   * → .textbox-content와 동일한 font-family/size/letter-spacing/font-weight/
   * font-style을 가진 숨겨진 span 하나를 만들어, 그 span의 실제 렌더링 폭
   * (getBoundingClientRect().width)을 재면 Canvas와 CSS 레이아웃 엔진 사이의
   * 괴리 자체가 원천적으로 사라진다(같은 파이프라인으로 재는 것이므로).
   *
   * span은 한 번만 만들어 document.body에 붙여두고 재사용한다(매 측정마다
   * DOM 엘리먼트를 새로 만들고 버리면 다수의 줄/단어를 측정할 때 불필요한
   * 레이아웃 스래싱이 생김). white-space: pre로 둬서 " "(공백)나 연속 공백도
   * .textbox-content가 실제로 렌더링하는 것과 동일하게 측정되게 한다.
   */
  _getMeasureElement(fontSizePx) {
    if (!this._measureEl) {
      try {
        const el = document.createElement("span");
        el.style.position = "absolute";
        el.style.visibility = "hidden";
        el.style.pointerEvents = "none";
        el.style.top = "-9999px";
        el.style.left = "-9999px";
        el.style.whiteSpace = "pre";
        document.body.appendChild(el);
        this._measureEl = el;
      } catch (_err) {
        this._measureEl = null;
      }
    }
    if (!this._measureEl) return null;

    // 폰트 정보는 .textbox-content가 렌더된 상태라면 매번 최신값으로 다시 읽는다
    // (chatFontSize 설정 변경, 웹폰트 로딩 완료 등으로 바뀔 수 있음). 아직 렌더된
    // 적이 없으면 이전에 캐시해둔 값 → 그마저 없으면 FALLBACK_FONT_FAMILY를 쓴다.
    const contentEl = this.element?.querySelector(".textbox-content");
    const computed = contentEl ? getComputedStyle(contentEl) : null;
    this._measuredFontFamily = computed?.fontFamily || this._measuredFontFamily || FALLBACK_FONT_FAMILY;

    this._measureEl.style.fontFamily = this._measuredFontFamily;
    this._measureEl.style.fontSize = `${fontSizePx}px`;
    this._measureEl.style.fontWeight = computed?.fontWeight || "normal";
    this._measureEl.style.fontStyle = computed?.fontStyle || "normal";
    this._measureEl.style.letterSpacing = computed?.letterSpacing || "normal";
    return this._measureEl;
  }

  /**
   * 문자열 s를 fontSizePx 크기로 렌더링했을 때의 실제 폭(px)을 잰다.
   * 숨겨진 DOM 요소를 지원하지 않는 극히 예외적인 환경이면 0을 반환해
   * 폭 기반 줄바꿈을 건너뛴다(이 경우 _paginateDialogue가 글자 폭을 0으로
   * 취급해 매 글자 줄바꿈 없이 그대로 이어지므로 최소한 텍스트 자체는
   * 안전하게 표시된다).
   */
  _measureTextWidth(s, fontSizePx) {
    const el = this._getMeasureElement(fontSizePx);
    if (!el) return 0;
    el.textContent = s;
    return el.getBoundingClientRect().width;
  }

  /**
   * 현재 표시 중인 대사(this._dialogue.rawText)를, 지금 이 순간의 대사창 폭(this.hudLayout.width)
   * 기준으로 다시 줄바꿈한다. 리사이즈 도중/직후에 호출되어 "이미 떠 있는 대사"가 새 폭에 맞게
   * 즉시 반응하도록 하는 용도 — _setDialogue()와 달리 sourceKey/캐시를 건드리지 않고
   * 페이지 배열만 새로 만든다. 타이핑 애니메이션 중이었어도 굳이 이어서 타이핑하지 않고
   * 현재 페이지를 즉시 전부 보여준다(리사이즈 중 어중간하게 타이핑이 재시작되는 걸 방지).
   */
  _repaginateForCurrentWidth() {
    if (!this._dialogue.rawText) return;
    const newPages = this._paginateDialogue(this._dialogue.rawText);
    if (!newPages.length) return;
    this._clearDialogueTimers();
    this._dialogue.pages = newPages;
    this._dialogue.pageIndex = Math.min(this._dialogue.pageIndex, newPages.length - 1);
    this._dialogue.typedChars = Array.from(newPages[this._dialogue.pageIndex]).length;
    this._dialogue.manualNavigation = true; // 자동 진행 타이머가 즉시 다시 돌지 않도록.
    this._dialogue.awaitingAdvance = this._dialogue.pageIndex < newPages.length - 1;
    this.render();
  }

  _hasVisibleDialogue() {
    return this._dialogue.historyIndex >= 0 || this._dialogue.pages.length > 0;
  }

  _visibleDialogueText() {
    if (this._dialogue.historyIndex >= 0) return this._dialogueHistory[this._dialogue.historyIndex]?.text || "";
    const page = this._dialogue.pages[this._dialogue.pageIndex] || "";
    return Array.from(page).slice(0, this._dialogue.typedChars).join("");
  }

  _visibleDialogueSpeakerName() {
    if (this._dialogue.historyIndex >= 0) return this._dialogueHistory[this._dialogue.historyIndex]?.speakerName || "";
    return this._dialogue.speakerName || "";
  }

  _startTypewriter() {
    this._clearDialogueTimers();
    if (this.minimized || this._dialogue.historyIndex >= 0 || this._dialogue.manualNavigation) return;

    const page = this._dialogue.pages[this._dialogue.pageIndex];
    if (page === undefined) return;
    const chars = Array.from(page);
    const content = this.element.querySelector("#theatre-dialogue-content");

    const typeNext = () => {
      if (this._dialogue.typedChars < chars.length) {
        this._dialogue.typedChars += 1;
        if (content) content.textContent = chars.slice(0, this._dialogue.typedChars).join("");
        if (this._dialogue.typedChars === chars.length) this._debugCheckRenderedLines(content, page);
        this._dialogue.typingTimer = setTimeout(typeNext, TYPE_INTERVAL_MS);
        return;
      }
      if (this._dialogue.pageIndex < this._dialogue.pages.length - 1) {
        this._dialogue.autoAdvanceTimer = setTimeout(() => this._goToNextPage(), AUTO_ADVANCE_DELAY_MS);
        return;
      }
      // 마지막 페이지까지 타이핑이 다 끝난 시점 = 이 대사를 다 읽은 시점.
      // 대기 중이던 다음 상태가 있으면, 페이지 넘김과 동일한 대기시간(AUTO_ADVANCE_DELAY_MS) 뒤에 적용한다.
      // 이 대기시간 동안에도 "아직 다 안 넘어갔다"고 취급해야 하므로 awaitingAdvance를 켜둔다.
      this._dialogue.awaitingAdvance = true;
      this._dialogue.autoAdvanceTimer = setTimeout(() => {
        this._dialogue.awaitingAdvance = false;
        this._applyPendingStateIfAny();
      }, AUTO_ADVANCE_DELAY_MS);
    };
    typeNext();
  }

  /**
   * TEMP DEBUG: JS가 계산한 줄 수와 브라우저가 실제로 그린 줄 수를 비교한다.
   * 검증 끝나면 이 메서드와 호출부(2곳) 다 지우면 됨.
   */
  _debugCheckRenderedLines(content, page) {
    if (!content) return;
    requestAnimationFrame(() => {
      const textNode = content.firstChild;
      if (!textNode) return;
      const jsLineCount = page.split("\n").length;
      let visualLineCount = 0;
      try {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rects = Array.from(range.getClientRects());
        const tops = new Set(rects.map((r) => Math.round(r.top)));
        visualLineCount = tops.size;
      } catch (err) {
        console.log("[theatre-linewrap-debug2] getClientRects 실패:", err);
        return;
      }
      console.log(
        `[theatre-linewrap-debug2] === 렌더 검증 === JS줄수=${jsLineCount} / 실제렌더줄수=${visualLineCount}` +
        (visualLineCount > jsLineCount ? "  ⚠️ 불일치!" : "  (일치)")
      );
      console.log("[theatre-linewrap-debug2] page:", JSON.stringify(page));
    });
  }

  _finishCurrentPage() {
    const page = this._dialogue.pages[this._dialogue.pageIndex] || "";
    this._clearDialogueTimers();
    this._dialogue.typedChars = Array.from(page).length;
    const content = this.element.querySelector("#theatre-dialogue-content");
    if (content) content.textContent = page;
    this._debugCheckRenderedLines(content, page);
    if (this._dialogue.pageIndex < this._dialogue.pages.length - 1) {
      this._dialogue.autoAdvanceTimer = setTimeout(() => this._goToNextPage(), AUTO_ADVANCE_DELAY_MS);
      return;
    }
    // 클릭으로 즉시 완성시킨 경우에도, 그 페이지가 마지막 페이지라면 동일한 대기시간 뒤에 "다 읽음" 처리한다.
    this._dialogue.awaitingAdvance = true;
    this._dialogue.autoAdvanceTimer = setTimeout(() => {
      this._dialogue.awaitingAdvance = false;
      this._applyPendingStateIfAny();
    }, AUTO_ADVANCE_DELAY_MS);
  }

  _advanceDialogue() {
    if (this._dialogue.historyIndex >= 0) return this._showNextDialogue();
    const page = this._dialogue.pages[this._dialogue.pageIndex] || "";
    if (this._dialogue.typedChars < Array.from(page).length) return this._finishCurrentPage();
    this._goToNextPage();
  }

  _goToNextPage() {
    if (this._dialogue.pageIndex >= this._dialogue.pages.length - 1) return;
    this._clearDialogueTimers();
    this._dialogue.pageIndex += 1;
    this._dialogue.typedChars = 0;
    this.render();
  }

  _showPreviousDialogue() {
    this._clearDialogueTimers();
    if (this._dialogue.historyIndex >= 0) {
      if (this._dialogue.historyIndex < this._dialogueHistory.length - 1) this._dialogue.historyIndex += 1;
    } else if (this._dialogue.pageIndex > 0) {
      this._dialogue.manualNavigation = true;
      this._dialogue.pageIndex -= 1;
      this._dialogue.typedChars = Array.from(this._dialogue.pages[this._dialogue.pageIndex]).length;
    } else if (this._dialogueHistory.length) {
      this._dialogue.historyIndex = 0;
    }
    this.render();
  }

  _showNextDialogue() {
    this._clearDialogueTimers();
    if (this._dialogue.historyIndex > 0) {
      this._dialogue.historyIndex -= 1;
    } else if (this._dialogue.historyIndex === 0) {
      this._dialogue.historyIndex = -1;
      this._dialogue.manualNavigation = false;
    }
    this.render();
  }

  /**
   * [»] ‹/›로 과거 히스토리나 이전 페이지를 열람 중이던 상태에서 한 번에 "지금 진행 중인
   * 가장 최근 대사"로 돌아간다. 이미 최신 상태면 아무 것도 하지 않는다.
   * _revealDialogueImmediately()와 동일한 패턴(마지막 페이지로 이동 + 전체 타이핑 완료 처리 +
   * manualNavigation=true)을 재사용해 render() 시 처음부터 재타이핑되지 않게 한다. 열람 중
   * 큐잉되어 있던 새 상태(_pendingState)가 있다면 즉시 적용한다.
   */
  _jumpToLatestDialogue() {
    const alreadyAtLatest =
      this._dialogue.historyIndex < 0 &&
      !this._dialogue.manualNavigation &&
      !this._dialogue.awaitingAdvance &&
      this._dialogue.pageIndex >= this._dialogue.pages.length - 1;
    if (alreadyAtLatest) return;

    this._clearDialogueTimers();
    this._dialogue.historyIndex = -1;
    if (this._dialogue.pages.length) {
      this._dialogue.pageIndex = this._dialogue.pages.length - 1;
      this._dialogue.typedChars = Array.from(this._dialogue.pages[this._dialogue.pageIndex]).length;
    }
    this._dialogue.manualNavigation = true;
    this._dialogue.awaitingAdvance = false;
    this.render();
    this._applyPendingStateIfAny();
  }

  /**
   * 소켓으로 브로드캐스트까지 하는 갱신 (GM 매니저 조작, @태그 명령 등
   * "채팅 로그와 별개로" 상태를 바꾸는 경우에 사용).
   */
  async updateAndBroadcast(newSlots, text = "", speakerName = this.currentSpeakerName, speakerActorId = this.currentSpeakerActorId, speakerAppearance = this.currentSpeakerAppearance, lockedSlots = this.lockedSlots, channelId = this.currentChannelId) {
    const lockedSlotsChanged = lockedSlots.some((v, i) => Boolean(v) !== Boolean(this.lockedSlots[i]));
    await this._applyState(newSlots, text, speakerName, speakerActorId, speakerAppearance, lockedSlots, true, null, channelId);
    // [Phase 4] 잠금은 채널과 무관한 전역 값이므로, _applyState가 화면 밖 채널로 빠져
    // this.lockedSlots를 갱신하지 못했더라도(off-screen 분기) 여기서 직접 반영·저장·전파한다.
    if (lockedSlotsChanged) {
      this.lockedSlots = Array.from({ length: 4 }, (_, i) => Boolean(lockedSlots[i]));
      this._persistLockedSlots();
      if (channelId !== this.currentChannelId) this.render();
    }
    // [Phase 4] channelId가 화면 밖 채널이면 this.slots/currentText 등은 그 상태를 반영하지
    // 않으므로(_applyState의 off-screen 분기), _statePayload()에 의존하지 않고 방금 적용한
    // 값을 그대로 페이로드로 구성한다.
    game.socket.emit(SOCKET_NAME, {
      type: "UPDATE_THEATRE",
      payload: {
        channelId,
        slots: newSlots,
        text,
        speakerName,
        speakerActorId,
        speakerAppearance: normalizeAppearance(speakerAppearance),
        lockedSlots: this.lockedSlots,
        updatedAt: this._getLastAppliedUpdatedAt(channelId)
      }
    });
  }

  /**
   * 소켓 브로드캐스트 없이 로컬에만 반영.
   * 일반 채팅(createChatMessage)은 이미 Foundry가 모든 클라이언트에
   * 동일한 메시지를 동기화해주므로, 각자 이 함수로 동일한 로직을 수행하면
   * 별도 브로드캐스트 없이도 화면이 맞춰집니다.
   */
  async applyLocalOnly(newSlots, text = "", speakerName = this.currentSpeakerName, speakerActorId = this.currentSpeakerActorId, speakerAppearance = this.currentSpeakerAppearance, channelId = this.currentChannelId) {
    // [CT-FIX2][버그 수정] 이 경로(일반 채팅 자동 감지 echo)는 "지금 막 확정된 새 사실"이
    // 아니라, 각 클라이언트가 이미 알고 있던 상태를 Foundry의 chat 동기화에 맞춰 다시
    // 그리는 것뿐이다. 지금 화면에 표시 중인 채널(channelId===currentChannelId)이면
    // sourceUpdatedAt을 비워(null) 넘길 경우 _applyState가 "방금 생긴 최신 상태"로 간주해
    // 이 채널의 시계를 Date.now()로 앞당겨버려, 뒤이어 도착하는 진짜 최신 상태(@태그로
    // 바뀐 표정)가 오히려 오래된 것으로 오인되어 stale-skip 당할 수 있다 — 그래서 이
    // 채널이 이미 알고 있는 시계를 그대로 넘긴다. 반대로 화면 밖 채널(다른 채널을 보고
    // 있는 동안 도착한 메인 채팅 등)은 이 호출이 그 채널에 대한 최초의 진짜 새 사실이므로
    // null(=지금 막 확정된 새 사실)로 넘겨 시계가 정상적으로 전진하게 한다.
    await this._applyState(
      newSlots, text, speakerName, speakerActorId, speakerAppearance, this.lockedSlots, true,
      channelId === this.currentChannelId ? this._getLastAppliedUpdatedAt(channelId) : null,
      channelId
    );
  }

  _statePayload(slotsAuthoritative = true) {
    return {
      // [Phase 4] 이 상태가 어느 채널 소속인지. 수신 측이 자신의 currentChannelId(=튜닝 중인
      // 채널)와 비교해 다르면 화면에 반영하지 않고 무시한다(3-2 결정).
      channelId: this.currentChannelId,
      // [버그 수정] this.slots를 참조 그대로 넘기면, 이 payload를 저장한 뒤 this.slots가
      // 다른 값으로 바뀌어도(또는 반대로 payload 쪽을 누가 mutate해도) 서로 영향을 주고받는다.
      // 매번 새 배열/새 슬롯 객체로 복사해서 넘긴다.
      slots: this.slots.map((slot) => (slot ? { ...slot } : null)),
      lockedSlots: [...this.lockedSlots],
      text: this.currentText,
      speakerName: this.currentSpeakerName,
      speakerActorId: this.currentSpeakerActorId,
      speakerAppearance: { ...this.currentSpeakerAppearance },
      // [CT-FIX][버그 수정] 이 스냅샷이 로컬에서 확정된 시각. 오래된 스냅샷을 가려내는 데
      // 사용 — 반드시 "지금 채널(this.currentChannelId)"의 시계여야 한다(전역 아님).
      updatedAt: this._getLastAppliedUpdatedAt(this.currentChannelId),
      // [CT-FIX v1.8.8] 이 스냅샷의 slots가 "새로 확정된 표정/배치"인지, 아니면 이미 있던
      // 슬롯을 그대로 다시 실어 보내는 것뿐인지. _persistChannelEntry/GM 병합 로직에서만
      // 쓰이고 world 설정에 그대로 저장되지는 않는다(저장 스키마는 그대로 유지).
      slotsAuthoritative
    };
  }

  _preloadStandingImages(slots) {
    const imagePaths = [...new Set(slots.map((slot) => slot?.expressionImg).filter(Boolean))];
    return Promise.all(imagePaths.map((path) => this._preloadStandingImage(path)));
  }

  _preloadStandingImage(path) {
    if (this._standingImagePreloads.has(path)) return this._standingImagePreloads.get(path);

    const preload = new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        if (typeof image.decode !== "function") return resolve();
        image.decode().catch(() => undefined).finally(resolve);
      };
      image.onerror = () => resolve(); // 잘못된 경로라도 HUD 전체 갱신은 막지 않는다.
      image.src = path;
    });
    this._standingImagePreloads.set(path, preload);
    return preload;
  }

  // sourceUpdatedAt: 이 상태가 "언제 확정됐는지"를 나타내는 값.
  //   - null(기본값) = 지금 이 클라이언트에서 방금 만들어진 새 상태 → 적용 시 Date.now()로 스탬프.
  //   - 숫자값 = 다른 곳(소켓/저장된 설정)에서 넘어온 상태의 원래 생성 시각 → 이미 적용된
  //     상태보다 오래됐으면(=경쟁에서 진 오래된 응답) 적용하지 않고 무시한다.
  async _applyState(newSlots, text, speakerName = "", speakerActorId = null, speakerAppearance = DEFAULT_APPEARANCE, lockedSlots = this.lockedSlots, persist = true, sourceUpdatedAt = null, channelId = this.currentChannelId, forceImmediate = false) {
    // [Phase 4] 이 상태가 지금 화면에 표시 중인 채널(this.currentChannelId)이 아닌 다른
    // 채널 소속이면, 화면(this.slots/대사 페이징/render)은 절대 건드리지 않고 그 채널의
    // 저장값만 갱신한다. 예: 내가 채널A를 튜닝 중인데 메인 채널에서 새 대사가 왔을 때.
    if (channelId !== this.currentChannelId) {
      if (persist) {
        const entryUpdatedAt = sourceUpdatedAt ?? Date.now();
        // [버그 수정] 화면 밖 채널이어도 "이 채널의 마지막으로 안 시각"은 갱신해둔다 —
        // updateAndBroadcast 등 호출부가 직후에 이 값을 읽어 소켓 payload/저장값에 쓰기
        // 때문에, 여기서 안 갱신하면 오래된(또는 0인) 값이 잘못 실려 나간다.
        this._lastAppliedUpdatedAtByChannel[channelId] = entryUpdatedAt;
        // [CT-FIX v1.8.8] 이 채널의 "지금 알려진(저장된)" 슬롯과 비교해 이번 저장 요청이
        // 실제로 표정/배치를 바꾸려는 것인지, 단순히 같은 슬롯을 다시 실어 보내는 것뿐인지
        // 판단한다. 자세한 이유는 _persistChannelEntry 쪽 주석 참고.
        const priorSlots = this._getWorkingSlotsForChannel(channelId);
        const slotsAuthoritative = !this._slotsEqual(priorSlots, newSlots);
        await this._persistChannelEntry(channelId, {
          slots: newSlots,
          text,
          speakerName,
          speakerActorId,
          speakerAppearance: normalizeAppearance(speakerAppearance),
          updatedAt: entryUpdatedAt,
          slotsAuthoritative
        });
      }
      return;
    }

    const incomingSourceKey = this._makeDialogueSourceKey(text, speakerName, speakerActorId);
    const isNewDialogue = incomingSourceKey !== this._dialogue.sourceKey;

    // 현재 대사를 아직 다 읽지 않았다면(마지막 페이지 타이핑 완료 전), 새 상태를 바로 덮어쓰지 않고
    // 대기시킨다. 이후 페이지가 끝까지 넘어가는 시점(_applyPendingStateIfAny)에 자동 적용된다.
    // 같은 대사에 대한 갱신(스탠딩만 바뀌는 경우 등)은 여기서 걸리지 않는다.
    // [딜레이 버그 수정] 단, 이 큐잉은 "같은 채널에 새 메시지가 도착했는데 아직 이전 대사를
    // 다 안 읽었다"는 상황을 위한 것이다. loadChannelDisplay(채널 전환)는 this.currentChannelId를
    // 먼저 새 채널로 바꾼 뒤 이 함수를 호출하므로, 위 "다른 채널이면 스킵" 분기를 통과해버려
    // 여기까지 내려온다 — 이때 this._dialogue는 여전히 "방금 떠나온" 이전 채널의 타이핑
    // 진행 상태라서, 사용자가 명시적으로 다른 채널을 보러 왔는데도 그 채널 내용이 화면에
    // 안 뜨고 이전 채널 타이핑이 끝날 때까지 큐에 갇혀 있었다(체감 지연의 실제 원인).
    // forceImmediate(채널 전환 등 명시적 사용자 조작)일 때는 이 대기를 걸지 않고 바로 적용한다.
    if (isNewDialogue && this._isDialogueInProgress() && !forceImmediate) {
      // [CT-FIX] 대기 상태에도 sourceUpdatedAt을 함께 보관해야, 나중에 실제로
      // 적용될 때(_applyPendingStateIfAny) 버전 가드가 정상적으로 판단할 수 있다.
      this._pendingState = { newSlots, text, speakerName, speakerActorId, speakerAppearance, lockedSlots, persist, sourceUpdatedAt };
      return;
    }
    // 새 상태가 적용되므로, 혹시 이전에 대기 중이던(그러나 이번 상태로 대체된) 항목은 폐기한다.
    this._pendingState = null;

    const normalizedAppearance = normalizeAppearance(speakerAppearance);
    // 최초 1회는(this._hasRenderedOnce === false) 상태가 기본값과 동일해도
    // 반드시 render()를 실행한다 — theatre.html의 <style> 태그를 DOM에
    // 삽입하기 위함. 그 다음부터는 기존처럼 동일 상태 갱신을 건너뛴다.
    // [Phase 4] 채널 전환 직후(=_lastAppliedChannelId가 아직 새 채널로 안 바뀐 시점)라면
    // 내용이 우연히 동일하더라도 건너뛰지 않는다 — 채널 버튼 바의 활성 표시가 갱신돼야 한다.
    if (this._hasRenderedOnce && channelId === this._lastAppliedChannelId && this._isSameHudState(newSlots, text, speakerName, speakerActorId, normalizedAppearance, lockedSlots)) return;

    const requestId = ++this._stateRequestId;

    await this._preloadStandingImages(newSlots);
    // 새 표정의 preload가 느린 동안 더 최근 상태가 들어왔다면, 오래된 DOM을
    // 다시 만들지 않는다. 이 경합이 한 프레임 깨짐의 주된 원인이었다.
    if (requestId !== this._stateRequestId) return;

    // [CT-FIX][버그 수정] 이 상태보다 이미 더 최신인 상태가 "이 채널에" 적용돼 있다면(도착
    // 순서가 뒤집힌 오래된 응답), 화면을 덮어쓰지 않고 조용히 무시한다. 로컬에서 방금 만든
    // 상태(sourceUpdatedAt === null)는 항상 최신으로 취급해 이 가드에 걸리지 않는다.
    // [버그 수정] 반드시 "이 채널(channelId)"의 시계와만 비교해야 한다 — 다른 채널의 더
    // 최신 시각과 비교하면, 채널 전환 시 그 채널의 정상적인(그러나 상대적으로 오래된) 저장
    // 상태를 매번 "오래됐다"며 무시해버리게 된다(채널 전환해도 표정이 안 바뀌던 원인).
    const lastAppliedForChannel = this._getLastAppliedUpdatedAt(channelId);
    if (sourceUpdatedAt !== null && sourceUpdatedAt < lastAppliedForChannel) {
      return;
    }
    this._lastAppliedUpdatedAtByChannel[channelId] = sourceUpdatedAt ?? Date.now();

    // [CT-FIX v1.8.8][문제 1 근본 수정] this.slots를 덮어쓰기 "직전"의 값을 기준으로, 이번
    // 적용이 실제로 표정/배치를 바꾸는 것인지(예: @태그, 신규 등장) 아니면 이미 슬롯을
    // 차지한 액터가 그냥 대사만 이어 치는 것인지(표정 내용은 동일) 판단해둔다. 이 값은
    // 잠시 뒤 persist 시점에 쓴다 — 반드시 덮어쓰기 전에 계산해야 한다.
    const slotsAuthoritative = !this._slotsEqual(this.slots, newSlots);
    this.slots = newSlots;
    // 원격 동기화·재접속 복원 뒤에도 일반 채팅이 마지막 표정을 유지하도록,
    // 현재 무대에 있는 액터의 표정을 각 클라이언트의 기억값에도 반영한다.
    for (const slot of newSlots) {
      if (slot?.actorId && slot.expressionImg) {
        this.lastExpressionByActor[slot.actorId] = slot.expressionImg;
      }
    }
    this.lockedSlots = Array.from({ length: 4 }, (_, i) => Boolean(lockedSlots?.[i]));
    this.currentText = text;
    this.currentSpeakerName = speakerName;
    this.currentSpeakerActorId = speakerActorId;
    this.currentSpeakerAppearance = normalizedAppearance;
    this._setDialogue(text, speakerName, speakerActorId);
    // [0안: A] 채널 전환/복원처럼 "이미 확정된 과거 상태"를 보여주는 경우, 처음부터
    // 글자 단위로 다시 타이핑하지 않고 마지막 페이지를 완성된 채로 즉시 보여준다.
    // 지금까지의 페이지는 <(이전) 버튼으로 그대로 열람 가능.
    if (forceImmediate) this._revealDialogueImmediately();
    this.currentChannelId = channelId;
    this._lastAppliedChannelId = channelId;
    await this.render();
    this._hasRenderedOnce = true;
    if (persist) this._persistChannelEntry(channelId, this._statePayload(slotsAuthoritative));
  }

  /**
   * [CT-FIX v1.8.8][문제 1: 간헐적 기본 표정 리셋 근본 수정]
   * 두 슬롯 배열이 "표정 관점에서" 같은 내용인지 비교한다(actorId/expressionImg만 비교,
   * standingScale 등 부가값은 무시). 이 결과로 지금 적용하려는 슬롯이 이전과 실제로
   * 다른지(=진짜 표정 변경 의도가 있는지) 판단해, 아래 slotsAuthoritative 플래그를 만든다.
   */
  _slotsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((slot, i) => {
      const other = b[i];
      if (!slot && !other) return true;
      if (!slot || !other) return false;
      return slot.actorId === other.actorId && slot.expressionImg === other.expressionImg;
    });
  }

  _isSameHudState(slots, text, speakerName, speakerActorId, appearance, lockedSlots) {
    const sameSlots = slots.length === this.slots.length && slots.every((slot, index) => {
      const current = this.slots[index];
      return slot?.actorId === current?.actorId
        && slot?.actorName === current?.actorName
        && slot?.expressionImg === current?.expressionImg
        && slot?.standingScale === current?.standingScale;
    });
    const sameLocks = Array.from({ length: 4 }, (_unused, index) => Boolean(lockedSlots?.[index]) === Boolean(this.lockedSlots[index])).every(Boolean);
    return sameSlots
      && sameLocks
      && text === this.currentText
      && speakerName === this.currentSpeakerName
      && speakerActorId === this.currentSpeakerActorId
      && appearance.nameColor === this.currentSpeakerAppearance.nameColor
      && appearance.standingScale === this.currentSpeakerAppearance.standingScale;
  }

  /**
   * 상태 지속성(persistence): 새로고침하거나 나중에 접속한 플레이어도
   * 현재 무대 상태를 볼 수 있도록 world 세팅에 저장합니다.
   * world 스코프 세팅은 GM만 쓸 수 있어 GM 클라이언트에서만 시도합니다.
   * (GM 클라이언트도 결국 동일한 _applyState 경로를 타므로, 매니저 조작/
   * 태그 명령/일반 채팅 어떤 경로로 상태가 바뀌든 여기서 한 번에 처리됩니다.)
   */
  /**
   * [Phase 4] 특정 채널의 상태 한 조각을 currentState 맵(채널ID → 상태)에 저장한다.
   * world 설정은 GM만 쓸 수 있으므로, 플레이어 클라이언트는 GM에게 저장을 요청한다
   * (기존 REQUEST_PERSIST_STATE와 동일한 패턴, 이름만 채널 스코프에 맞게 바꿈).
   */
  async _persistChannelEntry(channelId, entry) {
    // [버그 수정] 저장 직전 마지막 경계에서 한 번 더 복사한다 — 호출부가 실수로 참조를
    // 그대로 넘기더라도, world 설정 캐시 객체와 TheatreApp의 살아있는 상태(this.slots 등)가
    // 같은 배열/객체를 공유하지 않도록 보장한다(채널 간 상태가 서로 새는 근본 원인이었음).
    const safeEntry = {
      slots: (Array.isArray(entry.slots) ? entry.slots : [null, null, null, null]).map((slot) => (slot ? { ...slot } : null)),
      text: entry.text || "",
      speakerName: entry.speakerName || "",
      speakerActorId: entry.speakerActorId || null,
      speakerAppearance: entry.speakerAppearance ? { ...entry.speakerAppearance } : {},
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
      // [CT-FIX v1.8.8] 명시적으로 false가 아니면(구버전 호출부 포함) 기존과 동일하게
      // "이 slots를 그대로 신뢰해 저장"한다 — 기본값은 항상 안전하게 true로 취급.
      slotsAuthoritative: entry.slotsAuthoritative !== false
    };
    if (!game.user?.isGM) {
      game.socket.emit(SOCKET_NAME, { type: "REQUEST_PERSIST_CHANNEL_STATE", payload: { channelId, entry: safeEntry } });
      return;
    }
    try {
      const raw = game.settings.get(MODULE_ID, "currentState");
      // [버그 수정] migrateChannelStateMap은 이미 맵 형태인 raw를 그대로(참조 공유) 돌려준다.
      // 여기서 얕은 복사로 새 맵 객체를 만들어, 아래 map[channelId] = ... 대입이 world 설정의
      // 캐시된 원본 객체를 직접 mutate하지 않고 새 객체를 만들어 set 하도록 한다.
      const map = { ...migrateChannelStateMap(raw) };
      const existing = map[channelId];
      // [CT-FIX v1.8.8][문제 1: 간헐적 기본 표정 리셋 근본 수정]
      // slotsAuthoritative=false(=단순 대사 갱신, 표정/배치는 안 바뀜)인 요청은 저장된
      // 슬롯을 절대 덮어쓰지 않고, 이미 저장돼 있던 슬롯을 그대로 유지한 채 대사/화자만
      // 갱신한다. updatedAt이 얼어붙은(과거 값을 그대로 재전송하는) 클라이언트가 있어도,
      // 그 요청이 "표정을 바꾸려는 의도가 없다"는 게 확인되므로 다른 곳에서 방금 확정된
      // 더 새 표정(@태그 등)을 되돌릴 수 없다. slotsAuthoritative=true(실제 표정/배치
      // 변경)인 요청만 슬롯을 갱신한다 — 이 경우는 기존과 동일하게 그대로 저장한다.
      const finalSlots = (safeEntry.slotsAuthoritative === false && Array.isArray(existing?.slots))
        ? existing.slots
        : safeEntry.slots;
      map[channelId] = {
        slots: finalSlots,
        text: safeEntry.text,
        speakerName: safeEntry.speakerName,
        speakerActorId: safeEntry.speakerActorId,
        speakerAppearance: safeEntry.speakerAppearance,
        updatedAt: safeEntry.updatedAt
      };
      const eligible = normalizeStandingEligibleChannels(game.settings.get(MODULE_ID, "standingEligibleChannels"));
      const pruned = pruneChannelStateMap(map, eligible);
      await game.settings.set(MODULE_ID, "currentState", pruned);
    } catch (err) {
      console.error("[Custom Theatre] 채널별 상태 저장(persist) 실패:", err);
    }
  }

  /** [Phase 4] 슬롯 잠금(lockedSlots)은 채널과 무관한 전역 값이라 별도 world 설정에 저장한다. */
  async _persistLockedSlots() {
    if (!game.user?.isGM) {
      game.socket.emit(SOCKET_NAME, { type: "REQUEST_PERSIST_LOCKED_SLOTS", payload: { lockedSlots: this.lockedSlots } });
      return;
    }
    try {
      await game.settings.set(MODULE_ID, "lockedSlots", this.lockedSlots);
    } catch (err) {
      console.error("[Custom Theatre] 슬롯 잠금 저장 실패:", err);
    }
  }

  /**
   * [Phase 4] channelId가 지금 화면에 표시 중인 채널(this.currentChannelId)이면 그 화면의
   * 현재 슬롯(this.slots)을 그대로 쓰고, 다른(=화면에 없는) 채널이면 저장된 맵에서 그
   * 채널의 슬롯을 직접 읽어온다 — 화면에 없는 채널의 발화가 엉뚱하게 지금 보고 있는
   * 채널의 슬롯을 기반으로 계산되는 것을 막는다.
   */
  _getWorkingSlotsForChannel(channelId) {
    if (channelId === this.currentChannelId) return [...this.slots];
    try {
      const raw = game.settings.get(MODULE_ID, "currentState");
      const map = migrateChannelStateMap(raw);
      return getChannelState(map, channelId).slots;
    } catch (err) {
      return [null, null, null, null];
    }
  }

  /** [버그 수정] 채널별로 독립된 "마지막 적용 시각"을 조회/기록한다(과거엔 전역 값 하나였음). */
  _getLastAppliedUpdatedAt(channelId) {
    return this._lastAppliedUpdatedAtByChannel[channelId] ?? 0;
  }

  /** [Phase 4] LRU 판단용 lastSpokenAt은 채널별로 분리해서 관리한다. */
  _getLastSpokenAtMapForChannel(channelId) {
    if (!this.lastSpokenAtByChannel[channelId]) this.lastSpokenAtByChannel[channelId] = {};
    return this.lastSpokenAtByChannel[channelId];
  }

  /**
   * [Phase 4] 스탠딩 채널 전환(버튼 클릭/GM 강제 전환) 시 호출. 그 채널에 저장된 마지막
   * 상태(스탠딩+대사+화자)를 currentState 맵에서 직접 불러와 즉시 표시한다.
   * (구버전의 "마지막 채팅 메시지로 재구성" 방식은 채널별 영구 상태 자체가 생기면서
   * 더 이상 필요 없어져 제거함 — 인계 문서 5장 5번 항목)
   * @returns {Promise<boolean>} 항상 true(호출부의 이중 render 방지 로직과 호환).
   */
  async loadChannelDisplay(channelId) {
    this.currentChannelId = channelId;
    let entry;
    try {
      const raw = game.settings.get(MODULE_ID, "currentState");
      const map = migrateChannelStateMap(raw);
      entry = getChannelState(map, channelId);
    } catch (err) {
      console.error("[Custom Theatre] 채널 상태 불러오기 실패:", err);
      entry = { slots: [null, null, null, null], text: "", speakerName: "", speakerActorId: null, speakerAppearance: {}, updatedAt: 0 };
    }
    await this._applyState(
      entry.slots, entry.text, entry.speakerName, entry.speakerActorId, entry.speakerAppearance,
      this.lockedSlots, false, entry.updatedAt, channelId, true // forceImmediate: 딜레이 버그 수정 + 즉시완성 표시(0안 A)
    );
    return true;
  }

  async renderWithData(payload) {
    // [Phase 4] channelId가 없는 페이로드(구버전 브로드캐스트와 겹치는 극히 드문 과도기 상황)는
    // 안전하게 메인 채널로 간주한다.
    const channelId = payload.channelId || STANDING_MAIN_CHANNEL_ID;
    // 슬롯 잠금은 채널과 무관한 전역 값이므로, 지금 보고 있는 채널이 아니어도 항상 반영한다.
    if (Array.isArray(payload.lockedSlots)) {
      const nextLocked = Array.from({ length: 4 }, (_, i) => Boolean(payload.lockedSlots[i]));
      const changed = nextLocked.some((v, i) => v !== this.lockedSlots[i]);
      if (changed) {
        this.lockedSlots = nextLocked;
        if (channelId !== this.currentChannelId) this.render(); // 화면 갱신(잠금 표시)만 필요
      }
    }
    await this._applyState(
      payload.slots || [null, null, null, null],
      payload.text || "",
      payload.speakerName || "",
      payload.speakerActorId || null,
      payload.speakerAppearance || DEFAULT_APPEARANCE,
      this.lockedSlots,
      false,
      // [CT-FIX] 원격에서 넘어온 상태이므로 원래 생성 시각을 그대로 넘겨 버전 가드가 판단하게 한다.
      // 구버전 페이로드 등 updatedAt이 없는 경우엔 0으로 취급해 "가장 오래된 것"으로 간주한다.
      typeof payload.updatedAt === "number" ? payload.updatedAt : 0,
      channelId
    );
  }

  /**
   * ready 시점에 저장된 마지막 상태를 복원 (새로고침/재접속 대응).
   * [Phase 4] 이 클라이언트가 튜닝 중이던 채널(myStandingChannel, client 스코프 — 없으면
   * 메인)의 상태를 currentState 맵에서 꺼내 복원한다. 슬롯 잠금(lockedSlots)은 채널과
   * 무관한 전역 값이라 별도 world 설정에서 읽는다.
   */
  async restorePersistedState() {
    try {
      const myChannel = game.settings.get(MODULE_ID, "myStandingChannel") || STANDING_MAIN_CHANNEL_ID;
      this.lockedSlots = Array.from({ length: 4 }, (_, i) => Boolean((game.settings.get(MODULE_ID, "lockedSlots") || [])[i]));

      const raw = game.settings.get(MODULE_ID, "currentState");
      const map = migrateChannelStateMap(raw);
      const saved = getChannelState(map, myChannel);

      // _applyState는 channelId가 this.currentChannelId와 다르면 "화면 밖 채널" 분기로 빠져
      // 아무것도 렌더하지 않는다. 시작 시점엔 튜닝 중이던 채널을 화면에 그려야 하므로 먼저
      // 맞춰준다(생성자 기본값은 항상 메인이라, 메인이 아닌 채널을 튜닝 중이었다면 반드시 필요).
      this.currentChannelId = myChannel;

      // 저장된 상태가 없어도(예: 무대에 아무도 없는 상태로 새로고침) _applyState를
      // 호출한다 — this._hasRenderedOnce가 false이므로 내부에서 최초 1회
      // render()가 보장되어, theatre.html의 <style> 태그가 항상 DOM에 삽입된다.
      await this._applyState(
        saved.slots,
        saved.text,
        saved.speakerName,
        saved.speakerActorId,
        saved.speakerAppearance,
        this.lockedSlots,
        // 저장된 상태가 없을 때는 다시 저장할 필요가 없으므로 persist를 끈다.
        Boolean(map[myChannel]),
        saved.updatedAt,
        myChannel,
        true // forceImmediate: 새로고침 복원도 채널 전환과 동일하게 "이미 확정된 과거 상태" — 즉시 완성 표시
      );
    } catch (err) {
      console.error("[Custom Theatre] 상태 복원(restore) 실패:", err);
    }
  }

  /**
   * [Phase 4, 3-5 결정] "전체 초기화"는 지금 GM 매니저에서 선택 중인 채널 하나만 지운다
   * (모든 채널을 다 지우지 않음). 슬롯 잠금(lockedSlots)은 채널과 무관한 전역 값이라
   * 여기서 함께 초기화하지 않는다 — 잠금 해제가 필요하면 별도로 setSlotLocked를 쓴다.
   */
  clearAll(channelId = this.currentChannelId) {
    if (channelId === this.currentChannelId) this.minimized = false;
    return this.updateAndBroadcast([null, null, null, null], "", "", null, DEFAULT_APPEARANCE, this.lockedSlots, channelId);
  }

  setSlot(index, slotData, channelId = this.currentChannelId) {
    const next = this._getWorkingSlotsForChannel(channelId);
    next[index] = slotData;
    if (slotData?.actorId) this._getLastSpokenAtMapForChannel(channelId)[slotData.actorId] = Date.now();
    const working = this._getWorkingChannelState(channelId);
    return this.updateAndBroadcast(next, working.text, working.speakerName, working.speakerActorId, working.speakerAppearance, this.lockedSlots, channelId);
  }

  clearSlot(index, channelId = this.currentChannelId) {
    return this.setSlot(index, null, channelId);
  }

  /**
   * "@퇴장" 커맨드 전용: 지정한 채널에서 이 액터가 차지하고 있는 슬롯을 찾아
   * 슬롯 '비우기'(clearSlot)와 동일한 로직으로 제거한다.
   * @returns {boolean} 실제로 슬롯을 비웠으면 true, 원래 이 채널 무대에 없었으면 false.
   */
  exitActorFromStanding(actorId, channelId = this.currentChannelId) {
    const slots = this._getWorkingSlotsForChannel(channelId);
    const idx = slots.findIndex((slot) => slot?.actorId === actorId);
    if (idx === -1) return false;
    this.clearSlot(idx, channelId);
    return true;
  }

  /**
   * 슬롯에 있는 스탠딩을 전부 비운다 (잠금 여부 무관, GM 전용 UI에서 호출).
   * - 잠금(🔒) 상태 자체는 그대로 유지된다. 다만 잠긴 슬롯의 이미지도 함께 지워진다.
   * - 대사창(현재 대사/화자)은 건드리지 않는다. 창을 끄는 것도 아니다.
   * [Phase 4] 지금 GM 매니저에서 선택 중인 채널의 스탠딩만 비운다.
   */
  clearAllStandings(channelId = this.currentChannelId) {
    const nextSlots = this._getWorkingSlotsForChannel(channelId).map(() => null);
    return this.updateStandingsOnly(nextSlots, { channelId });
  }

  /** [Phase 4, 3-5 결정] 슬롯 잠금은 채널과 무관한 전역 값 — 채널 스코프 없이 항상 전체에 적용. */
  setSlotLocked(index, locked) {
    const nextLocks = [...this.lockedSlots];
    nextLocks[index] = Boolean(locked);
    this.lockedSlots = nextLocks;
    this._persistLockedSlots();
    this.render();
    game.socket.emit(SOCKET_NAME, {
      type: "UPDATE_THEATRE",
      payload: {
        channelId: this.currentChannelId,
        slots: this.slots,
        text: this.currentText,
        speakerName: this.currentSpeakerName,
        speakerActorId: this.currentSpeakerActorId,
        speakerAppearance: this.currentSpeakerAppearance,
        lockedSlots: nextLocks,
        updatedAt: Date.now()
      }
    });
  }

  refreshActorAppearance(actor, { broadcast = true } = {}) {
    const appearance = this._getActorAppearance(actor);
    const nextSlots = this.slots.map((slot) => slot?.actorId === actor.id ? { ...slot, standingScale: appearance.standingScale } : slot);
    const speakerAppearance = this.currentSpeakerActorId === actor.id ? appearance : this.currentSpeakerAppearance;
    if (broadcast) {
      return this.updateAndBroadcast(nextSlots, this.currentText, this.currentSpeakerName, this.currentSpeakerActorId, speakerAppearance);
    }
    return this._applyState(
      nextSlots,
      this.currentText,
      this.currentSpeakerName,
      this.currentSpeakerActorId,
      speakerAppearance,
      this.lockedSlots,
      false
    );
  }

  _getActorAppearance(actor) {
    return normalizeAppearance(actor.getFlag(MODULE_ID, "appearance") || {});
  }

  _makeSlotData(actor, expressionImg) {
    return {
      actorId: actor.id,
      actorName: actor.name,
      expressionImg,
      standingScale: this._getActorAppearance(actor).standingScale
    };
  }

  /**
   * 매니저에서만 사용하는 수동 슬롯 배정.
   * - 동일 액터는 무대에 한 번만 존재하도록 기존 배정을 제거한다.
   * - 지정한 슬롯의 기존 캐릭터는 가장 낮은 번호의 빈 슬롯으로 이동한다.
   * - 빈 슬롯이 없으면 그 캐릭터는 퇴장한다.
   * 자동 발화의 빈 슬롯/LRU 교체 규칙에는 이 로직을 적용하지 않는다.
   */
  async assignManualSlot(index, slotData, channelId = this.currentChannelId) {
    const next = this._getWorkingSlotsForChannel(channelId);
    const displaced = next[index];

    // 수동 배정에서만 액터 중복을 정리한다. 지정 슬롯도 비운 뒤 새 데이터를 넣는다.
    for (let i = 0; i < next.length; i += 1) {
      if (next[i]?.actorId === slotData.actorId) next[i] = null;
    }
    next[index] = slotData;

    // 다른 캐릭터를 덮어쓴 경우에만, 가장 번호가 낮은 빈 슬롯으로 밀어낸다.
    if (displaced && displaced.actorId !== slotData.actorId) {
      const emptyIndex = next.findIndex((slot) => slot === null);
      if (emptyIndex !== -1) next[emptyIndex] = displaced;
    }

    return this.updateStandingsOnly(next, { channelId });
  }

  /** 대사/화자/타이핑 상태를 건드리지 않고 스탠딩만 갱신한다. */
  async updateStandingsOnly(newSlots, { emit = true, channelId = this.currentChannelId } = {}) {
    const onScreen = channelId === this.currentChannelId;
    await this._applyState(
      newSlots,
      onScreen ? this.currentText : this._getWorkingChannelState(channelId).text,
      onScreen ? this.currentSpeakerName : this._getWorkingChannelState(channelId).speakerName,
      onScreen ? this.currentSpeakerActorId : this._getWorkingChannelState(channelId).speakerActorId,
      onScreen ? this.currentSpeakerAppearance : this._getWorkingChannelState(channelId).speakerAppearance,
      this.lockedSlots,
      true,
      null,
      channelId
    );
    if (emit) {
      game.socket.emit(SOCKET_NAME, {
        type: "UPDATE_THEATRE",
        payload: {
          channelId, slots: newSlots,
          text: onScreen ? this.currentText : this._getWorkingChannelState(channelId).text,
          speakerName: onScreen ? this.currentSpeakerName : this._getWorkingChannelState(channelId).speakerName,
          speakerActorId: onScreen ? this.currentSpeakerActorId : this._getWorkingChannelState(channelId).speakerActorId,
          speakerAppearance: onScreen ? this.currentSpeakerAppearance : this._getWorkingChannelState(channelId).speakerAppearance,
          lockedSlots: this.lockedSlots,
          updatedAt: this._getLastAppliedUpdatedAt(channelId)
        }
      });
    }
  }

  /** [Phase 4] channelId가 화면 밖 채널일 때, 대사/화자 등 나머지 필드를 저장된 맵에서 읽어온다. */
  _getWorkingChannelState(channelId) {
    if (channelId === this.currentChannelId) {
      return { text: this.currentText, speakerName: this.currentSpeakerName, speakerActorId: this.currentSpeakerActorId, speakerAppearance: this.currentSpeakerAppearance };
    }
    try {
      const raw = game.settings.get(MODULE_ID, "currentState");
      return getChannelState(migrateChannelStateMap(raw), channelId);
    } catch (err) {
      return { text: "", speakerName: "", speakerActorId: null, speakerAppearance: {} };
    }
  }

  /** @표정만 입력했을 때 사용하는, 발화로 취급하지 않는 스탠딩 갱신 경로. */
  async changeExpressionOnly(actor, expressionImg, { emit = true, channelId = this.currentChannelId } = {}) {
    this.lastExpressionByActor[actor.id] = expressionImg;
    const newSlots = this._getWorkingSlotsForChannel(channelId);
    let slotIndex = newSlots.findIndex((slot, index) => !this.lockedSlots[index] && slot?.actorId === actor.id);

    if (slotIndex === -1) {
      slotIndex = AUTO_SLOT_PRIORITY.find((index) => !this.lockedSlots[index] && newSlots[index] === null) ?? -1;
      if (slotIndex === -1) {
        const availableIndices = newSlots.map((_slot, index) => index).filter((index) => !this.lockedSlots[index]);
        slotIndex = availableIndices.length ? this._findLRUSlotIndex(newSlots, availableIndices, channelId) : -1;
      }
    }
    if (slotIndex !== -1) newSlots[slotIndex] = this._makeSlotData(actor, expressionImg);
    return this.updateStandingsOnly(newSlots, { emit, channelId });
  }

  /**
   * 등록된 표정이 삭제되었을 때, 그 표정을 쓰고 있던 슬롯을 자동으로 비웁니다.
   * (참조 무결성: 죽은 이미지 경로가 슬롯에 남지 않도록)
   */
  clearSlotsUsingExpression(actorId, expressionImg) {
    const idx = this.slots.findIndex(
      (s) => s?.actorId === actorId && s?.expressionImg === expressionImg
    );
    if (idx !== -1) return this.clearSlot(idx);
  }

  /**
   * 캐릭터가 "말했을 때" 호출하는 메인 진입점.
   * - 이미 슬롯에 있으면 표정은 건드리지 않고 그 슬롯의 이름/대사만 갱신한다.
   *   (표정 변경은 오직 @태그(forcedExpressionImg)로만 일어난다 — 일반 대사가 매번
   *   표정을 "다시 고르던" 것이 클라이언트별 로컬 캐시 레이스의 원인이었다.)
   * - 없으면 빈 슬롯에 배치, 4개 다 찼으면 가장 오래전에 말한 캐릭터를 교체(LRU)
   * - forcedExpressionImg가 없고 슬롯도 새로 만드는 경우에만: 서버(액터 문서)에 동기화되는
   *   chatPortraitLastExpression flag → 없으면 등록된 첫 표정 → 그것도 없으면 스탠딩 없이 대사만
   *
   * @param {Actor} actor
   * @param {string|null} text - null이면 기존 대사 유지
   * @param {string|null} forcedExpressionImg - @태그로 지정된 표정 이미지 (있으면 우선 사용)
   * @param {{emit: boolean, displayName: string|null}} options - emit=true면 소켓 브로드캐스트(주로 GM/태그 명령),
   *   false면 로컬 반영만(일반 채팅 자동 감지). displayName을 주면 텍스트박스 이름표에 actor.name 대신
   *   그 값을 쓴다(초상화/표정 매칭은 여전히 actor 기준 — 한 토큰으로 여러 이름의 NPC를 말하게 하는
   *   매크로 등에서, 채팅 로그의 alias와 스탠딩 박스 이름표를 일치시키기 위함).
   */
  async speakAs(actor, text, forcedExpressionImg = null, { emit = false, displayName = null, channelId = this.currentChannelId } = {}) {
    const now = Date.now();

    // [Phase 4] 이 발화가 화면 밖 채널(currentChannelId와 다른 채널) 것이면, 지금 화면에
    // 보이는 슬롯(this.slots)이 아니라 그 채널 자신의 저장된 슬롯을 기준으로 계산한다.
    const newSlots = this._getWorkingSlotsForChannel(channelId);
    const lastSpokenAt = this._getLastSpokenAtMapForChannel(channelId);
    // 잠긴 슬롯은 자동 발화의 대상에서 완전히 제외한다.
    let slotIndex = newSlots.findIndex((s, index) => !this.lockedSlots[index] && s?.actorId === actor.id);

    let expressionImg = forcedExpressionImg;

    if (slotIndex !== -1 && !forcedExpressionImg) {
      // [Phase 4 버그 수정] "이 채널 자신의" 슬롯에 이미 저장된 값을 최우선으로 쓴다.
      // 그 값이 없는 예외적인 경우(과도기/구버전 데이터 등)에만, 채널별 마지막 표정
      // 저장소(getLastExpressionForChannel — 채팅 초상화와 공유)를 최후의 안전망으로 쓴다.
      // [표정 오염 수정] 예전에는 이 폴백이 액터 전역 flag였다 — 그래서 A채널에서 @태그로
      // 표정을 바꾸면 그 값이 전역으로 갱신되어, B채널이 이 폴백을 타는 순간(드묾) A채널
      // 표정이 새어 들어올 수 있었다. 지금은 "이 채널(channelId)" 키로만 조회하므로 다른
      // 채널의 변경이 섞이지 않는다.
      const slotOwnExpressionImg = newSlots[slotIndex]?.expressionImg ?? null;
      expressionImg = slotOwnExpressionImg ?? getLastExpressionForChannel(actor, channelId) ?? null;
    } else if (!expressionImg) {
      // 새로 슬롯에 배치되는 경우(이 채널에서의 첫 등장)에만 표정을 골라야 한다.
      const expressions = actor.getFlag(MODULE_ID, "expressions") ?? [];
      if (expressions.length) {
        // [표정 오염 수정] 여기가 인계문서 3장에서 결정이 필요하다고 남겨뒀던 지점이다.
        // 전역 flag 대신 "이 채널(channelId)에서 이 액터의 마지막 표정"을 조회한다(인계문서
        // (나)안 채택) — 채널마다 독립된 기억을 갖게 되어, 다른 채널에서 방금 바꾼 표정이
        // 이 채널의 첫 등장 표정으로 새어 들어가지 않는다. 이 채널에서 아직 한 번도 표정이
        // 기록된 적 없으면(=완전히 처음 등장) 등록된 첫 표정으로 폴백한다.
        const storageValue = getLastExpressionForChannel(actor, channelId);
        expressionImg = storageValue ?? expressions[0].img;
      }
    }

    if (expressionImg) this.lastExpressionByActor[actor.id] = expressionImg;

    if (expressionImg) {
      if (slotIndex === -1) {
        slotIndex = AUTO_SLOT_PRIORITY.find((index) => !this.lockedSlots[index] && newSlots[index] === null) ?? -1;
        if (slotIndex === -1) {
          const availableIndices = newSlots.map((_slot, index) => index).filter((index) => !this.lockedSlots[index]);
          slotIndex = availableIndices.length ? this._findLRUSlotIndex(newSlots, availableIndices, channelId) : -1;
        }
      }
      if (slotIndex !== -1) newSlots[slotIndex] = this._makeSlotData(actor, expressionImg);
    }
    // expressionImg가 끝까지 없다면(등록된 표정이 하나도 없는 액터) 슬롯은 건드리지 않고 대사만 갱신

    lastSpokenAt[actor.id] = now;

    const displayText = text ?? (channelId === this.currentChannelId ? this.currentText : this._getWorkingChannelState(channelId).text);
    const speakerLabel = displayName?.trim() || actor.name;

    if (emit) {
      await this.updateAndBroadcast(newSlots, displayText, speakerLabel, actor.id, this._getActorAppearance(actor), this.lockedSlots, channelId);
    } else {
      await this.applyLocalOnly(newSlots, displayText, speakerLabel, actor.id, this._getActorAppearance(actor), channelId);
    }
  }

  /**
   * Actor 문서와 연결되지 않은 화자(alias)의 발화 처리.
   * - 예: NPC 대사 매크로(speaker.alias로 이름만 지정), 나레이터 툴(alias 없음)
   * - 슬롯(스탠딩 이미지)은 건드리지 않고, 이름표+대사만 갱신합니다.
   * - aliasName이 비어있으면(예: 순수 시스템/판정 안내 메시지) 이름표 없이 텍스트만 표시됩니다.
   *
   * @param {string} aliasName - 화자 이름. 빈 문자열이면 이름표 없이 텍스트만 표시.
   * @param {string} text
   * @param {{emit: boolean}} options
   */
  async speakAsAlias(aliasName, text, { emit = false, channelId = this.currentChannelId } = {}) {
    const newSlots = this._getWorkingSlotsForChannel(channelId);
    const displayText = text ?? this._getWorkingChannelState(channelId).text;
    if (emit) {
      await this.updateAndBroadcast(newSlots, displayText, aliasName || "", null, DEFAULT_APPEARANCE, this.lockedSlots, channelId);
    } else {
      await this.applyLocalOnly(newSlots, displayText, aliasName || "", null, DEFAULT_APPEARANCE, channelId);
    }
  }

  /** 현재 채워진 슬롯 중 가장 오래전에 말한 액터의 슬롯 인덱스를 반환 (LRU 교체용, 채널별) */
  _findLRUSlotIndex(slots, allowedIndices = slots.map((_slot, index) => index), channelId = this.currentChannelId) {
    const lastSpokenAt = this._getLastSpokenAtMapForChannel(channelId);
    let oldestIdx = 0;
    let oldestTime = Infinity;
    slots.forEach((s, i) => {
      if (!allowedIndices.includes(i)) return;
      if (!s) return;
      const t = lastSpokenAt[s.actorId] ?? 0;
      if (t < oldestTime) {
        oldestTime = t;
        oldestIdx = i;
      }
    });
    return oldestIdx;
  }
}
