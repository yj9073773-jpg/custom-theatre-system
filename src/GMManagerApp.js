import { theatreApp } from "./main.js";
import {
  MODULE_ID,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  normalizeChatPortraitPreset,
  getChatPortraitCropStyle,
  STANDING_MAIN_CHANNEL_ID,
  STANDING_MAIN_CHANNEL_LABEL,
  getChatChannelsApi,
  normalizeStandingEligibleChannels,
  setLastExpressionForChannel,
  clearLastExpressionReferences,
  getWorldExpressionsFolder,
  ensureWorldExpressionsFolder,
  scanExpressionFolderFiles
} from "./module-config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const LOCAL_TYPOGRAPHY_KEY = `${MODULE_ID}.hudTypography`;

/** HTML 문자열에 사용자/서버 유래 텍스트(파일명, 경로, 에러 메시지 등)를 안전하게 끼워넣기 위한 이스케이프. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** browse()가 반환하는 경로 마지막 조각(파일명)을 사람이 읽을 수 있게 디코드한다. 실패하면 원본 그대로. */
function decodeFileName(path) {
  const rawName = path.split("/").pop() || path;
  try {
    return decodeURIComponent(rawName);
  } catch (_err) {
    return rawName;
  }
}

/**
 * GM과 액터 소유자가 함께 사용하는 무대 매니저 창.
 * - 액터 선택
 * - 액터별 표정(expression) 이미지 등록/삭제 (actor.flags에 영구 저장)
 * - 표정 체크박스로 선택 → 상단 1~4번 슬롯 버튼으로 배정 / 해제
 * - 전체 초기화
 */
export class TheatreGMManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "theatre-gm-manager",
    tag: "div",
    window: {
      title: "무대 매니저 (Theatre Manager)",
      icon: "fa-solid fa-masks-theater",
      resizable: true
    },
    position: { width: 720, height: 640 },
    actions: {
      selectActor: TheatreGMManager.#onSelectActor,
      uploadExpressions: TheatreGMManager.#onUploadExpressions,
      renameExpression: TheatreGMManager.#onRenameExpression,
      removeExpression: TheatreGMManager.#onRemoveExpression,
      assignSlot: TheatreGMManager.#onAssignSlot,
      clearSlot: TheatreGMManager.#onClearSlot,
      toggleSlotLock: TheatreGMManager.#onToggleSlotLock,
      saveAppearance: TheatreGMManager.#onSaveAppearance,
      openChatPortraitEditor: TheatreGMManager.#onOpenChatPortraitEditor,
      selectExpression: TheatreGMManager.#onSelectExpression,
      clearAll: TheatreGMManager.#onClearAll,
      findUnusedExpressionFiles: TheatreGMManager.#onFindUnusedExpressionFiles,
      resetPosition: TheatreGMManager.#onResetPosition,
      selectManagerChannel: TheatreGMManager.#onSelectManagerChannel
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/gm-manager.html` }
  };

  constructor(options = {}) {
    super(options);
    this.selectedActorId = options.actorId ?? null;
    // 표정 목록에서 체크박스로 선택된 "배정 대상" 표정의 img 경로.
    // 액터를 바꾸면 다른 액터의 표정을 가리키게 되므로 selectActor 시 초기화한다.
    this.selectedExpressionImg = null;
    // [Phase 4, 3-5 결정] 매니저가 지금 편집 대상으로 삼는 채널. null이면 "GM 자신의
    // 스탠딩 튜닝 채널(theatreApp.currentChannelId)을 따라간다"는 뜻 — 매니저를 열 때마다
    // 매번 GM 본인 화면과 같은 채널에서 시작하되, 매니저 안에서 다른 채널을 선택하면
    // 그 뒤로는 GM 본인 화면 전환과 독립적으로 그 채널을 계속 편집 대상으로 유지한다.
    this.selectedChannelId = null;
  }

  /** [Phase 4] 매니저가 지금 실제로 편집 대상으로 삼고 있는 채널 id. */
  _effectiveChannelId() {
    return this.selectedChannelId || theatreApp?.currentChannelId || STANDING_MAIN_CHANNEL_ID;
  }

  /** 싱글턴으로 열기 (매크로/버튼에서 호출) */
  static open(actorId = null) {
    if (!TheatreGMManager._instance) {
      TheatreGMManager._instance = new TheatreGMManager({ actorId });
    } else if (actorId) {
      TheatreGMManager._instance.selectedActorId = actorId;
    }
    TheatreGMManager._instance.render(true);
    return TheatreGMManager._instance;
  }

  async _prepareContext(_options) {
    const actors = game.actors.contents
      .filter((actor) => this._canManageActor(actor))
      .map((a) => ({ id: a.id, name: a.name, img: a.img }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const selectedActor = this.selectedActorId ? game.actors.get(this.selectedActorId) : null;
    if (selectedActor && !this._canManageActor(selectedActor)) this.selectedActorId = null;
    const activeActor = this.selectedActorId ? game.actors.get(this.selectedActorId) : null;
    const expressions = activeActor ? this._getExpressions(activeActor) : [];

    // [Phase 4, 결정 사항] "현재 무대(1~4번 슬롯)" 탭 위에 GM이 스탠딩 버튼바에 노출시킨
    // 채널(+메인) 목록을 보여주고, 그중 하나를 선택해 그 채널의 슬롯을 개별로 편집한다.
    const effectiveChannelId = this._effectiveChannelId();
    const standingChannelSelector = this._buildStandingChannelSelector(effectiveChannelId);
    const channelSlots = theatreApp?._getWorkingSlotsForChannel(effectiveChannelId) ?? [null, null, null, null];

    return {
      actors,
      selectedActor: activeActor
        ? { id: activeActor.id, name: activeActor.name, img: activeActor.img }
        : null,
      expressions,
      slots: channelSlots,
      lockedSlots: theatreApp?.lockedSlots ?? [false, false, false, false],
      standingChannelSelector,
      selectedExpressionImg: this.selectedExpressionImg,
      appearance: activeActor ? this._getAppearance(activeActor) : DEFAULT_APPEARANCE,
      globalTypography: this._getLocalTypography(),
      globalStandingScale: theatreApp?.getLocalGlobalStandingScale() ?? 1,
      standingSpacing: theatreApp?.getLocalStandingSpacing() ?? 0.8,
      canEditSelected: Boolean(activeActor && this._canManageActor(activeActor)),
      isGM: game.user.isGM
    };
  }

  /**
   * [Phase 4] "메인" + GM이 스탠딩 버튼바에 노출시킨 채널(최대 3개) 목록을 매니저의 채널
   * 선택 UI용으로 구성한다. custom-chat-channels가 없거나 GM이 아직 노출 채널을 하나도
   * 고르지 않았으면 메인 하나만 표시한다(항상 최소 1개는 있어야 편집 대상이 존재함).
   */
  _buildStandingChannelSelector(effectiveChannelId) {
    const options = [{ id: STANDING_MAIN_CHANNEL_ID, name: STANDING_MAIN_CHANNEL_LABEL, active: effectiveChannelId === STANDING_MAIN_CHANNEL_ID }];
    const api = getChatChannelsApi();
    if (!api) return options;
    const eligibleIds = normalizeStandingEligibleChannels(game.settings.get(MODULE_ID, "standingEligibleChannels")).filter(Boolean);
    for (const channelId of eligibleIds) {
      const channel = api.getChannelById(channelId);
      if (!channel) continue; // GM이 지정한 뒤 삭제된 채널일 수 있음
      options.push({ id: channelId, name: channel.name, active: effectiveChannelId === channelId });
    }
    return options;
  }

  _getExpressions(actor) {
    return actor.getFlag(MODULE_ID, "expressions") ?? [];
  }

  async _setExpressions(actor, expressions) {
    return actor.setFlag(MODULE_ID, "expressions", expressions);
  }

  _getAppearance(actor) {
    return normalizeAppearance(actor.getFlag(MODULE_ID, "appearance") || {});
  }

  _getLocalTypography() {
    const fallback = { nameFontSize: DEFAULT_APPEARANCE.nameFontSize, chatFontSize: DEFAULT_APPEARANCE.chatFontSize };
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_TYPOGRAPHY_KEY));
      const value = saved || {};
      return {
        nameFontSize: Number.isFinite(Number(value.nameFontSize)) ? Math.min(32, Math.max(12, Number(value.nameFontSize))) : fallback.nameFontSize,
        chatFontSize: Number.isFinite(Number(value.chatFontSize)) ? Math.min(30, Math.max(14, Number(value.chatFontSize))) : fallback.chatFontSize
      };
    } catch (_err) {
      return fallback;
    }
  }

  _setLocalTypography(typography) {
    localStorage.setItem(LOCAL_TYPOGRAPHY_KEY, JSON.stringify(typography));
  }

  _canManageActor(actor) {
    return game.user.isGM || actor.isOwner;
  }

  // ---------- 액션 핸들러 (this는 앱 인스턴스로 바인딩됨) ----------

  static async #onSelectActor(_event, target) {
    this.selectedActorId = target.dataset.actorId;
    this.selectedExpressionImg = null;
    this.render();
  }

  /** 표정 목록의 선택 체크박스: 단일 선택(라디오처럼 동작)으로 "배정 대상" 표정을 지정한다. */
  static async #onSelectExpression(_event, target) {
    const actor = game.actors.get(this.selectedActorId);
    if (!actor) return;

    const idx = Number(target.dataset.index);
    const expressions = this._getExpressions(actor);
    const expression = expressions[idx];
    if (!expression) return;

    // 이미 선택된 항목을 다시 클릭하면 선택 해제, 아니면 새로 선택(다른 선택은 자동 해제).
    this.selectedExpressionImg = (this.selectedExpressionImg === expression.img) ? null : expression.img;
    this.render();
  }

  /** 업로드할 이미지에 사용할 @표정 태그 이름을 받는다. */
  static async #promptExpressionName(defaultName, { title = "표정 태그 등록", label = "등록" } = {}) {
    const escapedName = defaultName
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    try {
      const { DialogV2 } = foundry.applications.api;
      const name = await DialogV2.prompt({
        window: { title },
        content: `<p>채팅에서 사용할 태그 이름을 입력하세요. 예: <code>@미소</code></p><input type="text" name="exprName" value="${escapedName}" autofocus>`,
        ok: {
          label,
          callback: (_event, button) => button.form.elements.exprName.value.trim()
        }
      });
      // "퇴장"은 스탠딩 텍스트 박스의 "@퇴장" 명령과 이름이 겹쳐 혼동/충돌을 일으키므로
      // 표정 태그 이름으로는 등록/변경할 수 없게 막는다(업로드·이름변경 양쪽 다 이 함수를
      // 공유해서 쓰므로 여기 한 곳만 막으면 됨).
      if (name === "퇴장") {
        ui.notifications.warn('"퇴장"은 @퇴장 명령과 겹쳐 표정 이름으로 사용할 수 없습니다. 다른 이름을 입력해주세요.');
        return null;
      }
      return name || null;
    } catch (_err) {
      return null;
    }
  }

  static async #onUploadExpressions(_event, _target) {
    const actor = game.actors.get(this.selectedActorId);
    if (!actor || !this._canManageActor(actor)) return ui.notifications.warn("소유한 액터만 편집할 수 있습니다.");

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []).filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;

      try {
        const expressions = this._getExpressions(actor);
        // [v1.9.3] 월드마다 모든 액터의 표정이 expressions/ 밑에 뒤섞이지 않도록,
        // 이 월드 전용 하위 폴더(expressions/<worldId>/)에 저장한다. 파일명은
        // 여전히 actor.id로 시작해 같은 월드 안 액터 간 충돌도 막는다.
        //
        // [실사용 확인] uploadPersistent는 대상 폴더가 없으면 예외를 던지지 않고
        // 자체적으로 빨간 알림만 띄운 뒤 조용히 실패한다(path 없는 결과 반환).
        // 그래서 실패 후 재시도하는 대신, 업로드 시도 "전에" 폴더 존재를 미리
        // 보장해서 애초에 실패 자체가 안 나게 한다.
        const worldFolder = getWorldExpressionsFolder();
        await ensureWorldExpressionsFolder();

        const uploaded = [];
        for (const file of files) {
          const defaultName = file.name.replace(/\.[^.]+$/, "");
          const name = await TheatreGMManager.#promptExpressionName(defaultName);
          if (!name) continue;
          const uploadFile = new File([file], `${actor.id}-${file.name}`, {
            type: file.type,
            lastModified: file.lastModified
          });
          const result = await FilePicker.uploadPersistent(MODULE_ID, worldFolder, uploadFile, {}, { notify: false });
          const path = result?.path;
          if (!path) throw new Error(`업로드 경로를 받지 못했습니다: ${file.name}`);
          if (expressions.some((expression) => expression.img === path)) continue;
          uploaded.push({ name, img: path });
        }
        if (!uploaded.length) return;
        await this._setExpressions(actor, [...expressions, ...uploaded]);
        ui.notifications.info(`${uploaded.length}개의 표정을 등록했습니다.`);
        this.render();
      } catch (err) {
        console.error("[Custom Theatre] 표정 이미지 업로드 실패:", err);
        const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
        ui.notifications.error(`표정 이미지를 업로드할 수 없습니다. GM이 먼저 표정을 한 번 등록해 폴더를 만들어야 할 수도 있습니다. 파일 업로드 권한과 서버 저장소를 확인해주세요.${detail}`);
      }
    });
    input.click();
  }

  static async #onRemoveExpression(_event, target) {
    const actor = game.actors.get(this.selectedActorId);
    if (!actor || !this._canManageActor(actor)) return ui.notifications.warn("소유한 액터만 편집할 수 있습니다.");

    const idx = Number(target.dataset.index);
    const expressions = this._getExpressions(actor);
    const removed = expressions[idx];
    expressions.splice(idx, 1);
    await this._setExpressions(actor, expressions);

    // 참조 무결성: 삭제된 표정을 쓰고 있던 슬롯이 있으면 자동으로 비운다.
    if (removed) {
      await theatreApp?.clearSlotsUsingExpression(actor.id, removed.img);

      // 채팅 초상화/스탠딩 공용 "채널별 마지막 표정" 저장소 정리: 삭제된 표정을
      // 참조하고 있는 채널 항목이 있으면 전부 비워서, 이후 그 채널의 일반 메시지/첫 등장이
      // 이미 삭제된 표정을 계속 참조하지 않고 정상 폴백(actor.img / 등록된 첫 표정)되게 한다.
      await clearLastExpressionReferences(actor, removed.img);

      if (this.selectedExpressionImg === removed.img) {
        this.selectedExpressionImg = null;
      }
      // [v1.9.2 되돌림] Foundry 코어는 파일 삭제 API/UI를 제공하지 않아(실사용으로
      // 확인됨) 여기서 서버 파일까지 자동으로 지우려던 시도는 제거했다. 대신
      // #onFindUnusedExpressionFiles로 GM이 안 쓰는 파일을 찾아 직접 지울 수 있게 한다.
    }

    this.render();
  }

  /** 이미지와 슬롯 참조는 그대로 두고 @태그에 쓰이는 표시 이름만 변경한다. */
  static async #onRenameExpression(_event, target) {
    const actor = game.actors.get(this.selectedActorId);
    if (!actor || !this._canManageActor(actor)) return ui.notifications.warn("소유한 액터만 편집할 수 있습니다.");

    const idx = Number(target.dataset.index);
    const expressions = this._getExpressions(actor);
    const expression = expressions[idx];
    if (!expression) return;

    const name = await TheatreGMManager.#promptExpressionName(expression.name, {
      title: "표정 이름 수정",
      label: "저장"
    });
    if (!name || name === expression.name) return;
    if (expressions.some((item, index) => index !== idx && item.name === name)) {
      return ui.notifications.warn("같은 이름의 표정이 이미 있습니다. @태그가 겹치지 않게 다른 이름을 입력해주세요.");
    }

    expressions[idx] = { ...expression, name };
    await this._setExpressions(actor, expressions);
    this.render();
  }

  static async #onAssignSlot(_event, target) {
    const actor = game.actors.get(this.selectedActorId);
    if (!actor || !this._canManageActor(actor)) return ui.notifications.warn("소유한 액터만 배정할 수 있습니다.");

    const slotIndex = Number(target.dataset.slotIndex);
    if (theatreApp.lockedSlots[slotIndex]) {
      return ui.notifications.warn(`슬롯 ${slotIndex + 1}은(는) 잠겨 있어 표정을 배정할 수 없습니다.`);
    }
    if (!this.selectedExpressionImg) {
      return ui.notifications.warn("먼저 배정할 표정을 목록에서 선택해주세요.");
    }
    const expressions = this._getExpressions(actor);
    const expression = expressions.find((item) => item.img === this.selectedExpressionImg);
    if (!expression) return;

    // [Phase 4] 지금 매니저에서 선택 중인 채널(_effectiveChannelId)에만 배정한다.
    const channelId = this._effectiveChannelId();
    // 채팅 초상화/스탠딩 공용 "채널별 마지막 표정" 저장소 갱신 지점 ②
    // (@태그를 거치지 않고 매니저에서 직접 슬롯 배정한 경우도 반영되어야 함).
    // 지금 매니저가 편집 중인 채널(channelId)에만 기록해, 다른 채널로 새지 않게 한다.
    await setLastExpressionForChannel(actor, channelId, expression.img);
    await theatreApp.assignManualSlot(slotIndex, theatreApp._makeSlotData(actor, expression.img), channelId);
    this.render();
  }

  static async #onClearSlot(_event, target) {
    const slotIndex = Number(target.dataset.slotIndex);
    await theatreApp.clearSlot(slotIndex, this._effectiveChannelId());
    this.render();
  }

  static async #onToggleSlotLock(_event, target) {
    const slotIndex = Number(target.dataset.slotIndex);
    // [Phase 4, 3-5 결정] 슬롯 잠금은 채널과 무관한 전역 값이라 채널 스코프가 필요 없다.
    await theatreApp.setSlotLocked(slotIndex, !theatreApp.lockedSlots[slotIndex]);
    this.render();
  }

  /** [Phase 4] 매니저 안에서만 쓰는 "편집 대상 채널" 전환. GM 본인 화면(스탠딩 튜닝 채널)은 건드리지 않는다. */
  static async #onSelectManagerChannel(_event, target) {
    const channelId = target.dataset.channelId;
    if (!channelId) return;
    this.selectedChannelId = channelId;
    this.render();
  }

  static async #onSaveAppearance(_event, _target) {
    const actor = game.actors.get(this.selectedActorId);
    if (!actor || !this._canManageActor(actor)) return ui.notifications.warn("소유한 액터만 편집할 수 있습니다.");
    const form = this.element.querySelector(".tm-appearance-form");
    const appearance = normalizeAppearance({
      nameColor: form?.elements.nameColor?.value,
      standingScale: form?.elements.standingScale?.value
    });
    await actor.setFlag(MODULE_ID, "appearance", {
      nameColor: appearance.nameColor,
      standingScale: appearance.standingScale
    });
    await theatreApp.refreshActorAppearance(actor);
    this.render();
  }

  /**
   * "[채팅 초상화 영역 지정]" 버튼 → 크롭 프리셋(최대 3개) 편집창 (3.2, 3.3).
   * 기존 매니저 레이아웃은 건드리지 않고, 버튼 하나가 여는 독립된 편집창(DialogV2) 안에서
   * 프리셋 선택 → 대표 이미지 선택 → 확대/이동 미리보기 → 배경색 → (2/3번 한정) 표정별 적용
   * 여부까지 한 화면에서 처리한다. 표정 목록 UI(우클릭 메뉴 등)는 별도로 추가하지 않는다.
   */
  static async #onOpenChatPortraitEditor(_event, _target) {
    const actor = game.actors.get(this.selectedActorId);
    if (!actor || !this._canManageActor(actor)) return ui.notifications.warn("소유한 액터만 편집할 수 있습니다.");

    const expressions = this._getExpressions(actor);
    if (!expressions.length) {
      return ui.notifications.warn("먼저 표정을 최소 1개 이상 등록한 뒤 채팅 초상화 영역을 지정할 수 있습니다.");
    }

    const savedPresets = actor.getFlag(MODULE_ID, "chatPortraitPresets") ?? [];

    const escapeAttr = (value) => String(value ?? "")
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const exprOptionsHtml = expressions
      .map((expr) => `<option value="${escapeAttr(expr.img)}">${escapeAttr(expr.name)}</option>`)
      .join("");

    const panelHtml = (i) => {
      const preset = normalizeChatPortraitPreset(savedPresets[i] || {});
      const initialRef = preset.refImg && expressions.some((e) => e.img === preset.refImg)
        ? preset.refImg
        : expressions[0].img;
      const isDefault = i === 0;

      // (버튼 재배치 요청) 진짜 저장/취소는 여전히 Foundry가 폼 하단에 렌더링하지만,
      // 배경색 바로 아래에는 그걸 그대로 위임 클릭하는 단축 버튼을 둔다(render 콜백에서 연결).
      const shortcutButtons = `
        <div style="display:flex;gap:8px;margin:10px 0;">
          <button type="button" data-ctp-shortcut="save" style="flex:1;padding:6px;cursor:pointer;">저장</button>
          <button type="button" data-ctp-shortcut="cancel" style="flex:1;padding:6px;cursor:pointer;">취소</button>
        </div>`;

      // (표정 목록 확장 요청) max-height를 고정 픽셀로 박아두면 창을 늘려도 그대로였다.
      // 대신 data-ctp-checklist만 달아두고, render 콜백의 ResizeObserver가 팝업 남은
      // 세로 공간을 재서 max-height를 매번 다시 계산해 채운다(초기값은 안전한 기본치).
      const checklist = isDefault ? "" : `
        <div style="font-size:11px;color:#999;margin:6px 0 2px;">이 프리셋을 사용할 표정 (체크 해제 시 기본(1번) 프리셋 사용)</div>
        <div data-ctp-checklist="${i}" style="max-height:110px;overflow-y:auto;display:grid;gap:2px;align-content:start;">
          ${expressions.map((expr, idx) => `
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;">
              <input type="checkbox" data-ctp-use="${i}" data-expr-index="${idx}" ${expr.presetIndex === i ? "checked" : ""}>
              ${escapeAttr(expr.name)}
            </label>`).join("")}
        </div>`;

      const cropStyle = getChatPortraitCropStyle(preset);
      const previewImgStyle = Object.entries(cropStyle.img)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
        .join(";");

      return `
        <div class="ctp-panel" data-ctp-panel="${i}" style="${i === 0 ? "" : "display:none;"}">
          <div class="tm-appearance-row"><label>대표 이미지</label>
            <select data-ctp-field="refImg" data-ctp-preset="${i}" data-ctp-initial="${escapeAttr(initialRef)}">${exprOptionsHtml}</select>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;margin:6px 0;">
            <div data-ctp-preview-wrap="${i}" style="width:96px;height:96px;overflow:hidden;border:1px solid #555;border-radius:4px;display:flex;align-items:center;justify-content:center;flex:0 0 96px;background:${cropStyle.background};">
              <img data-ctp-preview="${i}" src="${escapeAttr(initialRef)}" style="${previewImgStyle}">
            </div>
            <div style="flex:1;display:grid;gap:4px;">
              <div class="tm-appearance-row"><label>확대</label><input type="range" data-ctp-field="scale" data-ctp-preset="${i}" min="1" max="6" step="0.03" value="${preset.scale}"></div>
              <div class="tm-appearance-row"><label>좌우 이동</label><input type="range" data-ctp-field="offsetX" data-ctp-preset="${i}" min="-50" max="50" step="0.5" value="${preset.offsetX}"></div>
              <div class="tm-appearance-row"><label>상하 이동</label><input type="range" data-ctp-field="offsetY" data-ctp-preset="${i}" min="-50" max="50" step="0.5" value="${preset.offsetY}"></div>
              <div class="tm-appearance-row"><label>배경색</label>
                <div style="display:flex;align-items:center;gap:6px;">
                  <input type="color" data-ctp-field="bgColor" data-ctp-preset="${i}" value="${preset.bgColor || "#000000"}" ${preset.bgColor ? "" : "disabled"}>
                  <label style="font-size:11px;display:flex;align-items:center;gap:3px;">
                    <input type="checkbox" data-ctp-transparent="${i}" ${preset.bgColor ? "" : "checked"}> 투명
                  </label>
                </div>
              </div>
            </div>
          </div>
          ${shortcutButtons}
          ${checklist}
        </div>`;
    };

    const content = `
      <style>
        .ctp-editor .ctp-tab-btn { padding: 4px 8px; font-size: 11px; cursor: pointer; }
        .ctp-editor .ctp-tab-btn.active { background: rgba(80,140,255,0.35); }
        .ctp-editor .tm-appearance-row { display: grid; grid-template-columns: 70px 1fr; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px; }
        .ctp-editor .tm-appearance-row input[type="range"] { width: 100%; }
      </style>
      <div class="ctp-editor">
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button type="button" data-ctp-tab="0" class="ctp-tab-btn">프리셋 1 (기본)</button>
          <button type="button" data-ctp-tab="1" class="ctp-tab-btn">프리셋 2</button>
          <button type="button" data-ctp-tab="2" class="ctp-tab-btn">프리셋 3</button>
        </div>
        ${[0, 1, 2].map(panelHtml).join("")}
      </div>`;

    try {
      const { DialogV2 } = foundry.applications.api;
      const result = await DialogV2.wait({
        id: `ctp-editor-${actor.id}`,
        // (핸들 추가) 레이아웃은 원래 버전 그대로 두고, 창 옵션에 resizable만 추가해서
        // 우측 하단에 세로 리사이즈 그립 핸들이 생기게 한다. position.height는 초기
        // 크기일 뿐이고, 내용이 넘치면 이전처럼 창 자체가 늘어나거나 필요시 내부
        // 스크롤(각 체크리스트의 max-height:110px)로 처리된다.
        window: { title: "채팅 초상화 영역 지정", resizable: true },
        position: { width: 420, height: 560 },
        content,
        rejectClose: false,
        buttons: [
          {
            action: "save",
            label: "저장",
            default: true,
            callback: (_event, button) => {
              const form = button.form;
              const presets = [0, 1, 2].map((i) => {
                const refImg = form.querySelector(`[data-ctp-field="refImg"][data-ctp-preset="${i}"]`)?.value || null;
                const scale = form.querySelector(`[data-ctp-field="scale"][data-ctp-preset="${i}"]`)?.value;
                const offsetX = form.querySelector(`[data-ctp-field="offsetX"][data-ctp-preset="${i}"]`)?.value;
                const offsetY = form.querySelector(`[data-ctp-field="offsetY"][data-ctp-preset="${i}"]`)?.value;
                const transparent = form.querySelector(`[data-ctp-transparent="${i}"]`)?.checked;
                const bgColor = transparent ? null : form.querySelector(`[data-ctp-field="bgColor"][data-ctp-preset="${i}"]`)?.value;
                return normalizeChatPortraitPreset({ refImg, scale, offsetX, offsetY, bgColor });
              });

              const presetIndexByExpr = expressions.map(() => 0);
              [1, 2].forEach((i) => {
                form.querySelectorAll(`[data-ctp-use="${i}"]`).forEach((checkbox) => {
                  if (checkbox.checked) presetIndexByExpr[Number(checkbox.dataset.exprIndex)] = i;
                });
              });

              return { presets, presetIndexByExpr };
            }
          },
          { action: "cancel", label: "취소", callback: () => null }
        ],
        // (버그 수정) render 콜백의 두 번째 인자는 HTML이 아니라 DialogV2 앱 인스턴스
        // 자체이다(공식 API: DialogV2RenderCallback = (event, dialog) => ...). 렌더된
        // HTML은 dialog.element로 꺼내야 한다. 이전에는 dialogHtml?.[0] 형태로 잘못
        // 짚어서 항상 undefined가 되어 탭 전환/실시간 미리보기가 전혀 동작하지 않았다.
        render: (_event, dialog) => {
          const root = dialog?.element;
          if (!root) return;

          const tabs = root.querySelectorAll("[data-ctp-tab]");
          const setActiveTab = (i) => {
            root.querySelectorAll("[data-ctp-panel]").forEach((panel) => {
              panel.style.display = panel.dataset.ctpPanel === String(i) ? "" : "none";
            });
            tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.ctpTab === String(i)));
            fitChecklist();
          };
          tabs.forEach((tab) => tab.addEventListener("click", () => setActiveTab(Number(tab.dataset.ctpTab))));

          // (버튼 재배치 요청) Foundry가 폼 하단에 렌더링하는 진짜 저장/취소 버튼을 텍스트로
          // 찾아 숨기고, 배경색 아래 단축 버튼 클릭이 그걸 그대로 위임 클릭하게 한다. 클래스명
          // 대신 버튼 텍스트로 찾기 때문에 Foundry 내부 마크업이 달라져도 안전하게 동작한다.
          const realButtons = Array.from(root.querySelectorAll("button"))
            .filter((btn) => !btn.closest(".ctp-panel") && !btn.hasAttribute("data-ctp-tab"));
          const realSave = realButtons.find((btn) => btn.textContent.trim() === "저장");
          const realCancel = realButtons.find((btn) => btn.textContent.trim() === "취소");
          const realFooter = realSave?.parentElement;
          if (realFooter) realFooter.style.display = "none";
          root.querySelectorAll('[data-ctp-shortcut="save"]').forEach((btn) => btn.addEventListener("click", () => realSave?.click()));
          root.querySelectorAll('[data-ctp-shortcut="cancel"]').forEach((btn) => btn.addEventListener("click", () => realCancel?.click()));

          // (표정 목록 확장 요청) 그립 핸들로 팝업을 늘리면, 현재 보이는 탭의 표정 체크리스트가
          // 남은 세로 공간을 그대로 채우도록 매번 다시 계산한다. .window-content 기준으로 계산해서
          // 특정 CSS 상속 구조에 기대지 않고 실측값으로 처리한다.
          function fitChecklist() {
            const windowContentEl = root.querySelector(".window-content") || root;
            const bottomLimit = windowContentEl.getBoundingClientRect().bottom;
            root.querySelectorAll("[data-ctp-checklist]").forEach((checklist) => {
              if (!checklist.offsetParent) return; // 비활성 탭의 목록은 건드리지 않음
              const top = checklist.getBoundingClientRect().top;
              checklist.style.maxHeight = Math.max(70, bottomLimit - top - 12) + "px";
            });
          }
          new ResizeObserver(() => fitChecklist()).observe(root);
          setActiveTab(0);

          // main.js의 실제 채팅 렌더링과 동일한 계산식(getChatPortraitCropStyle)을 써서,
          // 편집창에서 본 크롭/이동이 실제 채팅에도 그대로 나오게 한다.
          const updatePreview = (i) => {
            const preview = root.querySelector(`[data-ctp-preview="${i}"]`);
            const wrap = root.querySelector(`[data-ctp-preview-wrap="${i}"]`);
            if (!preview) return;
            const scale = Number(root.querySelector(`[data-ctp-field="scale"][data-ctp-preset="${i}"]`)?.value) || 1;
            const offsetX = Number(root.querySelector(`[data-ctp-field="offsetX"][data-ctp-preset="${i}"]`)?.value) || 0;
            const offsetY = Number(root.querySelector(`[data-ctp-field="offsetY"][data-ctp-preset="${i}"]`)?.value) || 0;
            const transparent = root.querySelector(`[data-ctp-transparent="${i}"]`)?.checked;
            const colorInput = root.querySelector(`[data-ctp-field="bgColor"][data-ctp-preset="${i}"]`);
            if (colorInput) colorInput.disabled = Boolean(transparent);
            const bgColor = transparent ? null : colorInput?.value;

            const cropStyle = getChatPortraitCropStyle({ scale, offsetX, offsetY, bgColor });
            Object.assign(preview.style, cropStyle.img);
            if (wrap) wrap.style.background = cropStyle.background;
          };

          [0, 1, 2].forEach((i) => {
            const refSelect = root.querySelector(`[data-ctp-field="refImg"][data-ctp-preset="${i}"]`);
            if (refSelect) refSelect.value = refSelect.dataset.ctpInitial;
            refSelect?.addEventListener("change", () => {
              const preview = root.querySelector(`[data-ctp-preview="${i}"]`);
              if (preview) preview.src = refSelect.value;
            });
            ["scale", "offsetX", "offsetY", "bgColor"].forEach((field) => {
              root.querySelector(`[data-ctp-field="${field}"][data-ctp-preset="${i}"]`)
                ?.addEventListener("input", () => updatePreview(i));
            });
            root.querySelector(`[data-ctp-transparent="${i}"]`)?.addEventListener("change", () => updatePreview(i));
            updatePreview(i);
          });
        }
      });

      if (!result) return; // 취소
      const { presets, presetIndexByExpr } = result;
      await actor.setFlag(MODULE_ID, "chatPortraitPresets", presets);
      const updatedExpressions = expressions.map((expr, idx) => ({ ...expr, presetIndex: presetIndexByExpr[idx] ?? 0 }));
      await this._setExpressions(actor, updatedExpressions);
      ui.notifications.info("채팅 초상화 영역 설정을 저장했습니다.");
      this.render();
    } catch (err) {
      console.error("[Custom Theatre] 채팅 초상화 영역 편집 중 오류:", err);
      ui.notifications.error("채팅 초상화 영역을 저장하지 못했습니다. 콘솔(F12)을 확인해주세요.");
    }
  }

  /**
   * [전체 설정(개인 적용) 실시간 반영] 이 폼은 client localStorage에만 저장되고
   * 서버/다른 플레이어와 통신하지 않는 "진짜 개인 전용" 설정이라, 저장 버튼 없이
   * 슬라이더를 조작하는 즉시(각 input 이벤트마다) 반영해도 부작용이 없다.
   * (반대로 #onSaveAppearance는 world/전체 플레이어에 영향을 주므로 버튼을 그대로 둔다.)
   */
  _applyLocalTypography() {
    const form = this.element.querySelector(".tm-typography-form");
    if (!form) return;
    const nameFontSize = Number(form.elements.nameFontSize?.value);
    const chatFontSize = Number(form.elements.chatFontSize?.value);
    const globalStandingScale = Number(form.elements.globalStandingScale?.value);
    const standingSpacing = Number(form.elements.standingSpacing?.value);
    this._setLocalTypography({
      nameFontSize: Number.isFinite(nameFontSize) ? Math.min(32, Math.max(12, nameFontSize)) : DEFAULT_APPEARANCE.nameFontSize,
      chatFontSize: Number.isFinite(chatFontSize) ? Math.min(30, Math.max(14, chatFontSize)) : DEFAULT_APPEARANCE.chatFontSize
    });
    theatreApp.setLocalStandingSettings(globalStandingScale, standingSpacing);
    // 여기서는 일부러 this.render()를 호출하지 않는다 — 매니저 창 전체를 매 input마다
    // 다시 그리면 슬라이더 드래그가 끊기고 포커스도 날아간다. 실제 HUD 갱신은
    // refreshLocalTypography()가 무대 HUD 쪽에서 처리한다.
    theatreApp.refreshLocalTypography();
  }

  /** [Phase: 전체 설정 실시간 반영] 렌더될 때마다 전체 설정 폼의 각 입력에 input 리스너를 새로 건다. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const form = this.element.querySelector(".tm-typography-form");
    form?.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => this._applyLocalTypography());
    });
  }

  static async #onClearAll(_event, _target) {
    if (!game.user.isGM) return ui.notifications.warn("전체 초기화는 GM만 사용할 수 있습니다.");
    // [Phase 4, 3-5 결정] 지금 매니저에서 선택 중인 채널 하나만 초기화한다(모든 채널 전체가 아님).
    await theatreApp.clearAll(this._effectiveChannelId());
    this.render();
  }

  /**
   * [v1.9.5] 월드 표정 폴더(expressions/<worldId>/)를 스캔해서 "실제 폴더 안 파일
   * 배치 그대로" 전체 파일을 GM에게 보여준다(조회 전용). 체크박스로 고르는 용도가
   * 아니라 눈으로 훑어보는 용도라, 미사용 파일만 따로 걸러 보여주기보다는 폴더
   * 그대로의 배치 위에 "지금 어떤 액터 표정 목록에도 안 걸려있는" 파일에만 두꺼운
   * 빨간 테두리를 쳐서 "이건 지워도 되는 파일"임을 바로 알아볼 수 있게 한다.
   * 옵션으로 월드 구분 전(과거) 루트 폴더도 같이 검사할 수 있지만, 다른 월드가
   * 그 파일을 쓰고 있는지 클라이언트에서 확인할 방법이 없어 기본은 꺼둔다.
   *
   * [정렬] 왼쪽 위 드롭다운으로 이름순/날짜순 각각 오름차순/내림차순을 고를 수
   * 있다. 날짜는 FilePicker.browse가 주지 않아 서버에 HEAD 요청을 보내 얻는데,
   * 호스팅 환경에 따라 못 받아올 수 있어("가능할 경우") 날짜 정보가 하나도 없으면
   * 날짜순 옵션을 비활성화한다. 정렬은 목록을 다시 불러오지 않고 이미 렌더된
   * 항목들을 화면에서 그대로 재배치하는 방식이라 즉시 반영된다.
   *
   * [v1.9.5 수정] Foundry 공개 API에는 파일 삭제/이동 기능이 없어(코어 내부
   * 비공식 소켓 이벤트에 기대는 방식은 실사용에서 응답 없이 무시됨을 확인),
   * "선택 → Not_used로 이동" 자동화 기능은 제거했다. 원본 삭제가 항상 실패해
   * 복사본만 계속 쌓이는 역효과가 있었기 때문. 이 다이얼로그는 이제 "폴더 안
   * 파일이 지금 어떻게 있는지 확인용 목록"만 보여주고, 실제 정리는 GM이 서버
   * 파일시스템에서 직접 하도록 안내한다.
   */
  static async #onFindUnusedExpressionFiles(_event, _target) {
    if (!game.user.isGM) return ui.notifications.warn("미사용 표정 파일 찾기는 GM만 사용할 수 있습니다.");

    const { DialogV2 } = foundry.applications.api;

    let includeLegacyRoot;
    try {
      includeLegacyRoot = await DialogV2.confirm({
        window: { title: "미사용 표정 파일 찾기" },
        content: `
          <p>월드 표정 폴더(<code>expressions/${escapeHtml(game.world.id)}</code>)를 기본으로 검사합니다.</p>
          <p>월드 구분 전(과거)에 올렸던 <b>루트 폴더</b>(<code>expressions/</code> 바로 밑)도 같이 검사할까요?
          이 폴더는 <b>다른 월드가 지금도 쓰고 있는지 확인할 방법이 없어서</b>, 여기 나온다고 해서
          정말 안 쓰는 파일이라고 보장할 수 없습니다. 확실하지 않으면 "월드 폴더만"을 선택하세요.</p>
        `,
        yes: { label: "루트 폴더도 포함" },
        no: { label: "월드 폴더만", default: true }
      });
    } catch (_err) {
      return; // 취소(모달 닫기)
    }

    let files;
    try {
      files = await scanExpressionFolderFiles({ includeLegacyRoot });
    } catch (err) {
      console.error("[Custom Theatre] 표정 파일 검색 실패:", err);
      return ui.notifications.error("표정 파일을 검색하지 못했습니다. 콘솔(F12)을 확인해주세요.");
    }

    if (!files.length) {
      await DialogV2.wait({
        window: { title: "미사용 표정 파일 찾기" },
        content: `<p>검사한 범위 안에 파일이 없습니다.</p>`,
        buttons: [{ action: "ok", label: "확인", default: true }]
      });
      return;
    }

    const unusedCount = files.filter((item) => !item.used).length;
    const anyDateAvailable = files.some((item) => item.date != null);

    const itemsHtml = files.map((item) => {
      const displayName = escapeHtml(decodeFileName(item.path));
      const legacyBadge = item.legacy ? `<span class="tm-unused-badge" title="다른 월드가 쓰고 있을 수 있어 사용 여부를 보장할 수 없음">루트</span>` : "";
      const unusedClass = item.used ? "" : " tm-unused-mark";
      const unusedBadge = item.used ? "" : `<span class="tm-unused-badge tm-unused-badge-del" title="어떤 액터 표정 목록에도 안 걸려있음">미사용</span>`;
      // data-tm-name/-date는 아래 render 콜백에서 DOM만 재배치하는 정렬에 쓴다(재조회 없음).
      return `
        <div class="tm-unused-item${unusedClass}" data-tm-name="${escapeHtml(decodeFileName(item.path).toLowerCase())}" data-tm-date="${item.date ?? ""}" title="${escapeHtml(item.path)}">
          <img src="${item.path}" loading="lazy" alt="">
          <span class="tm-unused-name">${displayName}</span>
          ${legacyBadge}${unusedBadge}
        </div>`;
    }).join("");

    // [v1.9.5 수정] 창 높이를 고정값으로 주지 않고, 내용 전체(안내문+그리드)를
    // .tm-unused-scroll 하나로 묶어 뷰포트 기준(vh)으로 스크롤시킨다. 이전에는
    // 그리드만 스크롤 처리되고 창은 고정 높이(560px)였어서, 안내문 길이에 따라
    // 창 자체가 넘쳐 하단 버튼(푸터)이 화면 밖으로 밀려나는 문제가 있었다.
    await DialogV2.wait({
      window: { title: `표정 파일 ${files.length}개 (미사용 ${unusedCount}개)`, resizable: true },
      position: { width: 640 },
      content: `
        <div class="tm-unused-scroll">
          <p>폴더 안에 있는 파일을 그대로 보여줍니다. <b style="color:#f66;">두꺼운 빨간 테두리</b>가
          쳐진 파일은 어떤 액터 표정 목록에도 걸려있지 않아 지워도 되는 파일입니다.
          Foundry는 모듈이 쓸 수 있는 파일 삭제/이동 API를 제공하지 않아, 이 목록은
          확인용입니다. 지우려면 서버 파일시스템(자가 호스팅이면 데이터 폴더)에서
          아래 경로를 직접 찾아 삭제해주세요.</p>
          <p style="font-size:11px;opacity:0.8;">폴더: <code>${escapeHtml(getWorldExpressionsFolder())}</code></p>
          <div class="tm-unused-toolbar">
            <label>정렬
              <select data-tm-sort>
                <option value="name-asc">이름순 (오름차순)</option>
                <option value="name-desc">이름순 (내림차순)</option>
                <option value="date-asc" ${anyDateAvailable ? "" : "disabled"}>날짜순 (오름차순)</option>
                <option value="date-desc" ${anyDateAvailable ? "" : "disabled"}>날짜순 (내림차순)</option>
              </select>
            </label>
            ${anyDateAvailable ? "" : `<span class="tm-unused-note" title="이 서버 환경에서는 파일 수정 날짜 정보를 받아올 수 없었습니다.">날짜 정보 없음</span>`}
          </div>
          <div class="tm-unused-grid">${itemsHtml}</div>
        </div>
      `,
      buttons: [{ action: "close", label: "닫기", default: true }],
      // [정렬 드롭다운] 목록을 다시 불러오지 않고, 이미 렌더된 .tm-unused-item
      // DOM 노드만 정렬 기준에 맞춰 grid 안에서 재배치한다. 날짜는 위에서 채워둔
      // data-tm-date(없으면 빈 문자열)를 쓰고, 값이 없는 항목은 정렬 기준 자체가
      // 없으므로 뒤쪽으로 보낸다.
      render: (_event, dialog) => {
        const root = dialog?.element;
        if (!root) return;
        const grid = root.querySelector(".tm-unused-grid");
        const select = root.querySelector("[data-tm-sort]");
        if (!grid || !select) return;

        const applySort = () => {
          const [field, dir] = select.value.split("-");
          const factor = dir === "desc" ? -1 : 1;
          const items = Array.from(grid.children);
          items.sort((a, b) => {
            if (field === "date") {
              const da = a.dataset.tmDate ? Number(a.dataset.tmDate) : null;
              const db = b.dataset.tmDate ? Number(b.dataset.tmDate) : null;
              if (da === null && db === null) return a.dataset.tmName.localeCompare(b.dataset.tmName);
              if (da === null) return 1; // 날짜 없는 항목은 항상 맨 뒤로
              if (db === null) return -1;
              return (da - db) * factor;
            }
            return a.dataset.tmName.localeCompare(b.dataset.tmName) * factor;
          });
          items.forEach((el) => grid.appendChild(el));
        };

        select.addEventListener("change", applySort);
      }
    });
  }

  // 이 버튼을 누른 사용자 자신의 화면에서만 스탠딩 텍스트 박스 위치를 기본
  // 위치(중앙 하단)로 되돌린다. 위치는 클라이언트별 localStorage 값이라
  // 다른 플레이어의 화면에는 영향을 주지 않는다. 레이아웃 크기, 잠금 여부 등
  // 다른 설정은 건드리지 않는다.
  static async #onResetPosition(_event, _target) {
    theatreApp.resetLocalPosition();
    ui.notifications.info("극장 위치가 초기화되었습니다. (내 화면에만 적용됨)");
  }
}
