import { theatreApp } from "./main.js";
import {
  MODULE_ID,
  getChatPortraitPreset,
  getChatPortraitCropStyle,
  getLastExpressionForChannel,
  setLastExpressionForChannel,
  getActiveStandingChannelId
} from "./module-config.js";

const LOG_PREFIX = "[Custom Theatre]";
const LOCAL_OPEN_KEY = `${MODULE_ID}.exprPickerOpen`;
const LOCAL_POSITION_KEY = `${MODULE_ID}.exprPickerPosition`;
const LOCAL_LIST_HEIGHT_KEY = `${MODULE_ID}.exprPickerListHeight`;
const THUMB_SIZE_PX = 65;
const VISIBLE_ROWS = 4;
const MIN_VISIBLE_ROWS = 2;
// 행 높이 근사치(썸네일 높이 + 행 상하 패딩 12px + 하단 보더 1px). 1,2번 CSS 조정 때 쓴
// max-height 계산식과 동일한 값을 그대로 재사용해 기본 높이/리사이즈 최소값을 계산한다.
const ROW_HEIGHT_PX = THUMB_SIZE_PX + 14;
const DEFAULT_LIST_HEIGHT_PX = VISIBLE_ROWS * ROW_HEIGHT_PX;
const MIN_LIST_HEIGHT_PX = MIN_VISIBLE_ROWS * ROW_HEIGHT_PX;

/**
 * [표정 선택 도우미] 무대 매니저 아이콘 우클릭으로 여닫는 작은 상시 위젯.
 *
 * - GM 매니저(ApplicationV2)를 쓰지 않고 TheatreApp 본체 HUD와 똑같은 "순수 DOM +
 *   localStorage" 패턴을 그대로 재사용한다. ApplicationV2/DialogV2는 Foundry 코어
 *   키바인딩상 Esc로 닫히는 걸 막을 확실한 방법이 없고, 위치·열림상태를 새로고침
 *   후에도 기억하는 기능이 코어에 내장돼 있지 않다 — 반면 이 위젯이 요구받은 동작
 *   ("위젯 같은 판정", "Esc로 안 꺼짐", "위치/열림상태 새로고침에도 유지")은 TheatreApp
 *   HUD가 이미 검증된 방식으로 구현해 둔 것과 정확히 같다.
 * - 표정 전환은 @표정 태그와 완전히 동일한 함수(setLastExpressionForChannel +
 *   theatreApp.changeExpressionOnly)를 직접 호출한다. 이 두 함수는 채팅 입력창
 *   (textarea)과 애초에 아무 연결이 없으므로, 버튼을 눌러도 플레이어가 지금 치고
 *   있는 채팅과 절대 섞이지 않는다 — 별도 분기가 필요한 게 아니라 구조적으로 안전하다.
 */
export class TheatreExpressionPicker {
  static _instance = null;

  constructor() {
    this.element = null;
    this.currentActor = null;
    this.currentActorId = null;
    this._hooksRegistered = false;
    this._customListHeightPx = null;
  }

  /** 무대 매니저 아이콘 우클릭 진입점. 이미 열려있으면 아무 동작 없이 그대로 둔다(닫기는 X 전용). */
  static ensureOpen() {
    if (!TheatreExpressionPicker._instance) {
      TheatreExpressionPicker._instance = new TheatreExpressionPicker();
    }
    TheatreExpressionPicker._instance.show();
    return TheatreExpressionPicker._instance;
  }

  /**
   * ready 훅에서 1회 호출. 사용자가 예전에 X로 직접 닫아둔 적이 있으면(localStorage에
   * "false"가 저장됨) 새로고침해도 계속 닫힌 채로 둔다. 그 외(최초 실행 포함)에는
   * 기본적으로 창을 띄운다.
   */
  static restore() {
    try {
      if (localStorage.getItem(LOCAL_OPEN_KEY) === "false") return;
    } catch (_err) {
      // localStorage 접근 불가(사설 모드 등) — 기본값(열림)으로 진행.
    }
    TheatreExpressionPicker.ensureOpen();
  }

  show() {
    try {
      localStorage.setItem(LOCAL_OPEN_KEY, "true");
    } catch (_err) {
      // 저장 실패해도 화면 표시 자체는 계속 진행.
    }
    if (!this.element) this._initDOM();
    this.render();
  }

  hide() {
    try {
      localStorage.setItem(LOCAL_OPEN_KEY, "false");
    } catch (_err) {
      // 저장 실패해도 닫기 자체는 계속 진행.
    }
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }

  _initDOM() {
    const container = document.createElement("div");
    container.id = "custom-theatre-expr-picker";
    document.body.appendChild(container);
    this.element = container;
    this._restoreLocalPosition();
    this._restoreLocalListHeight();
    this._setupDragAndEvents();
  }

  _restoreLocalPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_POSITION_KEY));
      if (!Number.isFinite(saved?.left) || !Number.isFinite(saved?.top)) return;
      this.element.style.left = `${saved.left}px`;
      this.element.style.top = `${saved.top}px`;
      this.element.style.right = "auto";
      this.element.style.bottom = "auto";
    } catch (_err) {
      // 저장값 없음/손상 — theatre.css 기본 위치(우측 상단 근처) 그대로 사용.
    }
  }

  _saveLocalPosition(left, top) {
    try {
      localStorage.setItem(LOCAL_POSITION_KEY, JSON.stringify({ left, top }));
    } catch (_err) {
      // 위치 저장 실패는 치명적이지 않으므로 무시.
    }
  }

  /** 저장된 목록 높이(리사이즈 결과)를 불러온다. 없거나 손상된 값이면 기본 높이(4개)를 쓴다. */
  _restoreLocalListHeight() {
    try {
      const raw = Number(localStorage.getItem(LOCAL_LIST_HEIGHT_KEY));
      this._customListHeightPx = Number.isFinite(raw) && raw > 0 ? raw : null;
    } catch (_err) {
      this._customListHeightPx = null;
    }
  }

  _saveLocalListHeight(heightPx) {
    try {
      localStorage.setItem(LOCAL_LIST_HEIGHT_KEY, String(Math.round(heightPx)));
    } catch (_err) {
      // 크기 저장 실패는 치명적이지 않으므로 무시.
    }
  }

  /** X 옆 초기화 버튼: 사용자가 직접 조절한 높이를 지우고 기본 높이(4개)로 되돌린다. */
  _resetListHeight() {
    this._customListHeightPx = null;
    try {
      localStorage.removeItem(LOCAL_LIST_HEIGHT_KEY);
    } catch (_err) {
      // 삭제 실패해도 이번 세션 값(null)은 이미 적용되므로 무시.
    }
    this.render();
  }

  /** 드래그(헤더)와 클릭 델리게이션(닫기/표정 선택)을 컨테이너에 한 번만 건다. */
  _setupDragAndEvents() {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    this.element.addEventListener("mousedown", (e) => {
      const handle = e.target.closest("#ctp-picker-drag-handle");
      if (!handle) return;
      e.preventDefault();

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      this.element.style.left = `${initialLeft}px`;
      this.element.style.top = `${initialTop}px`;
      this.element.style.right = "auto";
      this.element.style.bottom = "auto";

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        this.element.style.left = `${initialLeft + (moveEvent.clientX - startX)}px`;
        this.element.style.top = `${initialTop + (moveEvent.clientY - startY)}px`;
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

    // [창 크기 조절] 목록 하단 리사이즈 핸들을 세로로 드래그해 표정 목록 높이를 조절한다.
    // 최소는 인장 2개 분량, 최대는 화면을 벗어나지 않는 선과 표정 전체 내용 높이 중
    // 더 작은 쪽(그 이상 늘려도 빈 공간만 생기므로)으로 매 드래그 시작 시 다시 계산한다.
    let isResizing = false;
    let resizeStartY, resizeInitialHeight, resizeMinHeight, resizeMaxHeight;

    this.element.addEventListener("mousedown", (e) => {
      const handle = e.target.closest("#ctp-picker-resize-handle");
      if (!handle) return;
      e.preventDefault();

      const list = this.element.querySelector(".ctp-picker-list");
      if (!list) return;

      isResizing = true;
      resizeStartY = e.clientY;
      resizeInitialHeight = list.getBoundingClientRect().height;
      resizeMinHeight = MIN_LIST_HEIGHT_PX;
      const containerTop = this.element.getBoundingClientRect().top;
      const viewportLimit = Math.max(resizeMinHeight, window.innerHeight - containerTop - 20);
      const contentLimit = Math.max(resizeMinHeight, list.scrollHeight);
      resizeMaxHeight = Math.min(viewportLimit, contentLimit);

      const onMouseMove = (moveEvent) => {
        if (!isResizing) return;
        const next = Math.min(
          Math.max(resizeInitialHeight + (moveEvent.clientY - resizeStartY), resizeMinHeight),
          resizeMaxHeight
        );
        list.style.height = `${next}px`;
      };

      const onMouseUp = () => {
        isResizing = false;
        const finalHeight = list.getBoundingClientRect().height;
        this._customListHeightPx = finalHeight;
        this._saveLocalListHeight(finalHeight);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    // render()가 매번 innerHTML을 통째로 교체하므로, 개별 버튼에 onclick을 다시 붙이는
    // 대신 컨테이너 자체에 델리게이션 리스너를 한 번만 건다(TheatreApp 본체 HUD의
    // #theatre-drag-handle 델리게이션과 동일한 방식).
    this.element.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='closePicker']")) {
        this.hide();
        return;
      }
      if (e.target.closest("[data-action='resetPickerSize']")) {
        this._resetListHeight();
        return;
      }
      const pickBtn = e.target.closest("[data-action='pickExpression']");
      if (pickBtn) this._onPickExpression(pickBtn.dataset.img);
    });

    this._registerLiveRefreshHooks();
  }

  /**
   * [실시간 자동 갱신] 화자가 바뀌거나(토큰 선택/배정 캐릭터 변경), 이 액터의 표정
   * 목록 자체가 매니저에서 편집되면 열려있는 창을 자동으로 다시 그린다. 위젯 인스턴스
   * 생성 시 한 번만 등록한다(hide()로 닫혀도 재등록하지 않음 — 창이 닫혀있을 땐
   * _refreshIfOpen()이 그냥 아무 일도 하지 않는다).
   */
  _registerLiveRefreshHooks() {
    if (this._hooksRegistered) return;
    this._hooksRegistered = true;

    Hooks.on("controlToken", () => this._refreshIfOpen());
    Hooks.on("updateUser", (user, changes) => {
      if (user.id === game.user?.id && "character" in changes) this._refreshIfOpen();
    });
    Hooks.on("updateActor", (actor, changes) => {
      if (!this.currentActorId || actor.id !== this.currentActorId) return;
      if (changes.flags?.[MODULE_ID]) this._refreshIfOpen();
    });
  }

  _refreshIfOpen() {
    if (this.element) this.render();
  }

  _getSpeakerActor() {
    try {
      const speaker = ChatMessage.getSpeaker();
      return speaker?.actor ? game.actors.get(speaker.actor) : null;
    } catch (_err) {
      return null;
    }
  }

  /**
   * @표정 태그(main.js의 chatMessage 훅)와 완전히 동일한 두 호출만 그대로 재사용한다.
   * 채팅 입력창(textarea)과는 애초에 연결이 없으므로 별도 격리 처리가 필요 없다.
   */
  async _onPickExpression(img) {
    const actor = this.currentActor;
    if (!actor || !img) return;
    const channelId = getActiveStandingChannelId();
    try {
      await setLastExpressionForChannel(actor, channelId, img);
      await theatreApp?.changeExpressionOnly(actor, img, { emit: true, channelId });
    } catch (err) {
      console.error(`${LOG_PREFIX} 표정 선택 도우미 표정 전환 실패:`, err);
    }
    this.render();
  }

  static _escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * [비활성 인터페이스 페이드] FVTT 코어의 "사용자 인터페이스 설정 > 페이드"에 있는
   * 값(core.uiConfig.fade.opacity/speed — 코어 좌/우 UI, 핫바 등이 마우스오버 안 하면
   * 흐려지는 그 설정)을 그대로 읽어와 이 위젯에도 동일하게 적용한다. 코어가 내부적으로
   * 관리하는 요소 목록에 이 위젯을 몰래 끼워 넣는 대신, 같은 설정값(투명도·전환 속도)을
   * 그대로 가져와 위젯 자체 CSS(:hover 시 opacity:1)로 동일한 동작을 구현한다 — 이렇게 하면
   * 코어 내부 구현이 버전마다 바뀌어도(선택자/클래스명 등) 값만 유효하면 계속 안전하게 동작한다.
   */
  _getInterfaceFadeConfig() {
    const fallback = { opacity: 0.4, speedMs: 250 };
    try {
      const uiConfig = game.settings.get("core", "uiConfig");
      const opacity = Number(uiConfig?.fade?.opacity);
      const speedMs = Number(uiConfig?.fade?.speed);
      return {
        opacity: Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : fallback.opacity,
        speedMs: Number.isFinite(speedMs) && speedMs >= 0 ? speedMs : fallback.speedMs
      };
    } catch (_err) {
      return fallback;
    }
  }

  render() {
    if (!this.element) return;

    const actor = this._getSpeakerActor();
    this.currentActor = actor;
    this.currentActorId = actor?.id ?? null;

    const channelId = getActiveStandingChannelId();
    const activeImg = actor ? getLastExpressionForChannel(actor, channelId) : null;
    const expressions = actor ? (actor.getFlag(MODULE_ID, "expressions") ?? []) : [];
    const escapeAttr = TheatreExpressionPicker._escapeAttr;

    const listHeightPx = this._customListHeightPx ?? DEFAULT_LIST_HEIGHT_PX;
    const fade = this._getInterfaceFadeConfig();

    const bodyHtml = !actor
      ? `<div class="ctp-picker-empty">화자로 지정된 액터가 없습니다</div>`
      : !expressions.length
        ? `<div class="ctp-picker-empty">등록된 표정이 없습니다</div>`
        : `<div class="ctp-picker-list" style="height:${listHeightPx}px;">${expressions.map((expr) => {
            const preset = getChatPortraitPreset(actor, expr.img);
            const cropStyle = getChatPortraitCropStyle(preset);
            const imgStyle = Object.entries(cropStyle.img)
              .filter(([, v]) => v !== "" && v !== undefined)
              .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
              .join(";");
            const isActive = !!activeImg && activeImg === expr.img;
            return `
              <div class="ctp-picker-row">
                <div class="ctp-picker-thumb-wrap" style="background:${cropStyle.background};">
                  <img src="${escapeAttr(expr.img)}" class="ctp-picker-thumb-img" style="${imgStyle}">
                </div>
                <span class="ctp-picker-name">${escapeAttr(expr.name)}</span>
                <button type="button" class="ctp-picker-dot-btn ${isActive ? "ctp-picker-dot-btn-active" : ""}"
                        data-action="pickExpression" data-img="${escapeAttr(expr.img)}"
                        title="${escapeAttr(expr.name)}(으)로 전환"></button>
              </div>`;
          }).join("")}</div><div id="ctp-picker-resize-handle" title="드래그하여 목록 높이 조절"></div>`;

    this.element.innerHTML = `
      <style>
      #custom-theatre-expr-picker {
        position: fixed;
        top: 120px;
        right: 20px;
        width: 235px;
        background: rgba(20, 20, 24, 0.95);
        border: 1px solid #555;
        border-radius: 6px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.5);
        z-index: 65;
        color: #ddd;
        font-size: 12px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        opacity: ${fade.opacity};
        transition: opacity ${fade.speedMs}ms ease;
      }
      #custom-theatre-expr-picker:hover { opacity: 1; }
      #ctp-picker-drag-handle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 8px;
        background: rgba(255,255,255,0.06);
        border-bottom: 1px solid #444;
        cursor: move;
        user-select: none;
        flex: 0 0 auto;
      }
      .ctp-picker-title { font-weight: bold; }
      .ctp-picker-header-btns { display: flex; align-items: center; gap: 2px; }
      .ctp-picker-reset,
      .ctp-picker-close {
        width: 18px; height: 18px; line-height: 1; font-size: 11px;
        border: none; background: transparent; color: #ccc; cursor: pointer; padding: 0;
      }
      .ctp-picker-reset:hover,
      .ctp-picker-close:hover { color: #fff; }
      .ctp-picker-empty { padding: 14px 8px; color: #888; text-align: center; }
      .ctp-picker-list { overflow-y: auto; }
      .ctp-picker-row {
        display: flex; align-items: center; gap: 6px;
        padding: 6px 8px; border-bottom: 1px solid #333;
      }
      .ctp-picker-row:last-child { border-bottom: none; }
      .ctp-picker-thumb-wrap {
        flex: 0 0 auto; width: ${THUMB_SIZE_PX}px; height: ${THUMB_SIZE_PX}px;
        border-radius: 50%; overflow: hidden; border: 1px solid #555;
        display: flex; align-items: center; justify-content: center;
      }
      .ctp-picker-thumb-img { display: block; }
      .ctp-picker-name {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ctp-picker-dot-btn {
        flex: 0 0 auto; width: 20px; height: 20px; min-width: 20px; min-height: 20px;
        max-width: 20px; max-height: 20px; aspect-ratio: 1 / 1; border-radius: 50%;
        box-sizing: border-box; border: 1px solid #888; background: rgba(255,255,255,0.05);
        cursor: pointer; padding: 0; margin: 0; line-height: 0; font-size: 0;
        appearance: none; -webkit-appearance: none;
      }
      .ctp-picker-dot-btn:hover { border-color: #aac8ff; }
      .ctp-picker-dot-btn-active { border-color: #6fa8ff; background: #6fa8ff; box-shadow: inset 0 0 0 3px rgba(0,0,0,0.35); }
      #ctp-picker-resize-handle {
        flex: 0 0 auto;
        height: 8px;
        cursor: ns-resize;
        background: rgba(255,255,255,0.05);
        position: relative;
        border-top: 1px solid #333;
      }
      #ctp-picker-resize-handle::after {
        content: "";
        position: absolute;
        left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: 28px; height: 3px;
        border-radius: 2px;
        background: rgba(255,255,255,0.35);
      }
      #ctp-picker-resize-handle:hover { background: rgba(255,255,255,0.12); }
      #ctp-picker-resize-handle:hover::after { background: rgba(255,255,255,0.65); }
      </style>
      <div id="ctp-picker-drag-handle">
        <span class="ctp-picker-title">표정 선택 도우미</span>
        <div class="ctp-picker-header-btns">
          <button type="button" class="ctp-picker-reset" data-action="resetPickerSize" title="창 크기 초기화">⟳</button>
          <button type="button" class="ctp-picker-close" data-action="closePicker" title="닫기">✕</button>
        </div>
      </div>
      ${bodyHtml}
    `;
  }
}
