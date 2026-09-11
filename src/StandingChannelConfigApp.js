import {
  MODULE_ID,
  MAX_STANDING_CHANNELS,
  normalizeStandingEligibleChannels,
  getChatChannelsApi,
  STANDING_MAIN_CHANNEL_ID,
  STANDING_MAIN_CHANNEL_LABEL
} from "./module-config.js";

const { ApplicationV2 } = foundry.applications.api;

/**
 * [Phase 3] "스탠딩 박스 우측 하단 채널 버튼" 옆 톱니바퀴로 여는 GM 전용 설정창.
 * custom-chat-channels의 채널 목록에서 슬롯 1/2/3에 각각 어떤 채널을 넣을지 드롭다운으로
 * 지정한다. standingEligibleChannels(world)에는 인덱스 = 슬롯 번호(0-based)인 길이
 * MAX_STANDING_CHANNELS 고정 배열로 저장되며, 빈 슬롯은 빈 문자열("")로 채워 인덱스를
 * 유지한다(module-config.js의 normalizeStandingEligibleChannels 참고). 슬롯 번호는 이
 * 설정창 안에서만 보이며, 스탠딩 박스 실제 버튼(HUD)에는 채널 이름만 표시한다(원칙 유지).
 *
 * 드롭다운 3개뿐인 단순한 창이라 HandlebarsApplicationMixin(PARTS/템플릿 파일)은
 * 쓰지 않고, 순수 ApplicationV2를 상속해 _renderHTML/_replaceHTML을 직접 구현한다
 * (항목이 늘어나면 그때 템플릿 파일로 분리한다).
 */
export class StandingChannelConfigApp extends ApplicationV2 {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "custom-theatre-standing-channel-config",
    tag: "div",
    window: {
      title: "스탠딩 채널 설정",
      icon: "fa-solid fa-gear",
      resizable: true
    },
    position: { width: 360, height: "auto" },
    actions: {
      save: StandingChannelConfigApp.#onSave
    }
  };

  constructor(options = {}) {
    super(options);
    // 길이 MAX_STANDING_CHANNELS 고정 배열(빈 슬롯은 ""). 인덱스 = 슬롯 번호(0-based).
    this.pendingSlots = normalizeStandingEligibleChannels(
      game.settings.get(MODULE_ID, "standingEligibleChannels")
    );
  }

  static open() {
    if (!StandingChannelConfigApp._instance) {
      StandingChannelConfigApp._instance = new StandingChannelConfigApp();
    }
    // 다시 열 때마다 world 설정의 최신 값으로 슬롯 상태를 새로고침한다.
    StandingChannelConfigApp._instance.pendingSlots = normalizeStandingEligibleChannels(
      game.settings.get(MODULE_ID, "standingEligibleChannels")
    );
    StandingChannelConfigApp._instance.render(true);
    return StandingChannelConfigApp._instance;
  }

  /** HandlebarsApplicationMixin의 PARTS 대신, 파일 템플릿 없이 직접 HTML 문자열을 만든다. */
  async _renderHTML(_context, _options) {
    const api = getChatChannelsApi();
    const realChannels = api ? api.getVisibleChannelsForCurrentUser() : []; // GM이므로 전체 채널이 반환됨
    // [버그 5] "메인"은 chat-channels의 정식 채널 데이터가 아니라 getVisibleChannelsForCurrentUser()에
    // 애초에 포함되지 않으므로, chat-log-ui.js가 메인 탭 버튼을 하드코딩하는 것과 같은 방식으로
    // 여기서도 별도 옵션으로 수동 추가한다. id로 STANDING_MAIN_CHANNEL_ID(내부 식별자)를 쓰면
    // 아래 중복 방지 로직도 실제 채널과 동일하게 그대로 적용된다.
    const channels = [{ id: STANDING_MAIN_CHANNEL_ID, name: STANDING_MAIN_CHANNEL_LABEL }, ...realChannels];

    const rows = channels.length
      ? this.pendingSlots
          .map((selectedId, slotIndex) => {
            const optionTags = [`<option value="">— 없음 —</option>`]
              .concat(
                channels.map((c) => {
                  // 이미 "다른" 슬롯에서 선택된 채널은 이 슬롯 드롭다운에서 고를 수 없게 막는다(중복 방지).
                  const usedInOtherSlot = this.pendingSlots.some((v, i) => i !== slotIndex && v === c.id);
                  const isSelected = selectedId === c.id;
                  return `<option value="${c.id}" ${isSelected ? "selected" : ""} ${usedInOtherSlot ? "disabled" : ""}>${foundry.utils.escapeHTML(c.name)}</option>`;
                })
              )
              .join("");
            return `
              <label class="ctp-scc-row">
                <span class="ctp-scc-slot-label">슬롯 ${slotIndex + 1}</span>
                <select class="ctp-scc-select" data-slot-index="${slotIndex}">${optionTags}</select>
              </label>`;
          })
          .join("")
      : `<p class="ctp-scc-empty">먼저 Custom Chat Channels에서 채널을 만들어주세요.</p>`;

    return `
      <form class="ctp-scc-form">
        <p class="ctp-scc-hint">스탠딩 박스에 버튼으로 노출할 채널을 슬롯별로 지정하세요(최대 ${MAX_STANDING_CHANNELS}개). 같은 채널을 두 슬롯에 중복 지정할 수 없습니다.</p>
        <div class="ctp-scc-list">${rows}</div>
        <button type="button" data-action="save" class="ctp-scc-save">저장</button>
      </form>
      <style>
        .ctp-scc-form { padding: 8px 4px; }
        .ctp-scc-hint { margin: 0 0 10px; font-size: 12px; opacity: 0.8; }
        .ctp-scc-list { display: flex; flex-direction: column; gap: 8px; }
        .ctp-scc-row { display: flex; align-items: center; gap: 8px; }
        .ctp-scc-slot-label { flex: 0 0 52px; font-size: 12px; opacity: 0.85; }
        .ctp-scc-select { flex: 1 1 auto; }
        .ctp-scc-empty { opacity: 0.7; font-style: italic; }
        .ctp-scc-save { margin-top: 12px; width: 100%; }
      </style>
    `;
  }

  async _replaceHTML(result, content, _options) {
    content.innerHTML = result;
    // [버그 2] ApplicationV2의 actions 델리게이션은 click 이벤트에만 반응하는데, <select>는
    // 열기 위해 클릭하는 그 자체가 이미 "click"이라 옵션을 고르기도 전에 핸들러가 실행되고
    // 그 안의 render()가 <select> DOM을 통째로 교체해버려 드롭다운이 열자마자 닫혀버렸다.
    // 같은 코드베이스 GMManagerApp.js가 <select>/<input> 값 변경에 쓰는 것과 동일한 패턴으로,
    // 렌더 직후 각 <select>에 change 리스너를 직접 붙인다.
    content.querySelectorAll(".ctp-scc-select").forEach((select) => {
      select.addEventListener("change", (event) => this.#onSelectChange(event));
    });
  }

  /**
   * 슬롯의 드롭다운 값이 바뀌면(change 이벤트) pendingSlots에 반영한다. 중복 선택은 이미
   * disabled 옵션으로 막혀 있지만, 방어적으로 한 번 더 확인해 중복이면 이전 값으로 되돌린다.
   */
  #onSelectChange(event) {
    const target = event.currentTarget;
    const slotIndex = Number(target.dataset.slotIndex);
    const value = target.value;
    if (value && this.pendingSlots.some((v, i) => i !== slotIndex && v === value)) {
      target.value = this.pendingSlots[slotIndex]; // 방어적 롤백
      return;
    }
    this.pendingSlots[slotIndex] = value;
    this.render();
  }

  static async #onSave() {
    await game.settings.set(MODULE_ID, "standingEligibleChannels", this.pendingSlots.slice());
    ui.notifications.info("스탠딩 채널 설정을 저장했습니다.");
    this.close();
  }
}
