// ==UserScript==
// @name         NiuLink 主节点配置跟随
// @namespace    https://linkcloud-admin.qiniu.io/
// @version      0.14.36
// @description  以主节点为模板，预览并批量同步配置、叠加业务，以及为验收不通过节点重提目标业务。
// @author       Codex
// @match        https://linkcloud-admin.qiniu.io/node-operation/resource/node*
// @match        https://linkcloud-admin.qiniu.io/node-commit/submitted*
// @match        https://linkcloud-admin.qiniu.io/node-commit/unCensored*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const NAME = 'NiuLinkNodeFollowMaster';
  const VERSION = '0.14.36';
  const PLATFORM_EXACT_DEMAND_MATCHING = true;
  const ROOT_ID = 'nlnfm-root';
  const STYLE_ID = 'nlnfm-style';
  const STORAGE_KEY = 'NiuLinkNodeFollowMaster.template.v1';
  const LOG_KEY = 'NiuLinkNodeFollowMaster.log.v1';
  const TARGETS_KEY = 'NiuLinkNodeFollowMaster.lockedTargets.v1';
  const VIRTUAL_REAL_DEFAULTS_KEY = 'NiuLinkNodeFollowMaster.virtualRealDefaults.v1';
  const DEFAULT_VIRTUAL_REAL_DEFAULTS_ROWS = [
    { virtualToken: '聚宝盆', realToken: 'k9异网联通' },
    { virtualToken: '七牛CDN-ZJ月95', realToken: 'z2' },
  ];
  const AUDIT_MAX_RECORDS = 24;
  const AUDIT_MAX_CHARS = 96 * 1024;
  const AUDIT_MAX_DEPTH = 4;
  const AUDIT_MAX_ARRAY_ITEMS = 16;
  const AUDIT_MAX_OBJECT_KEYS = 20;
  const AUDIT_MAX_STRING_CHARS = 600;
  const NODE_ID_PATTERN = /\b[a-f0-9]{32}\b/i;
  const NODE_API = '/api/proxy/jarvis/v1/nodes/';
  const NODE_LIST_API = '/api/proxy/jarvis/v2/nodes';
  const DEMAND_API = '/api/proxy/jarvis/v1/demandinfo/list';
  const CUSTOMERS_API = '/api/proxy/jarvis/v1/customers';
  const VIRTUAL_CUSTOMERS_API = '/api/proxy/jarvis/v1/customers/virtual';
  const DEFAULT_OPTIONS = { schedule: true, ipSchedule: true, networkType: false, boardParams: false };
  const MAX_TARGETS = 30;
  const WRITE_CONCURRENCY = 4;
  const BUSINESS_SWITCH_STAGES = new Set(['censored', 'inService']);
  const BUSINESS_RESUBMIT_STAGES = new Set(['uncensored']);
  const BUSINESS_SWITCH_POST_STAGES = new Set(['censored', 'inService', 'submitted']);
  const BUSINESS_RESUBMIT_POST_STAGES = new Set(['submitted']);
  const AUTO_DEMAND_MIN_SCORE = 55;
  const AUTO_DEMAND_MIN_GAP = 15;
  const STACKABLE_REAL_BUSINESS_IDS = new Set([10000001]);
  const DEFAULT_REPORTING_CITY_BY_PROVINCE = {
    北京: '北京',
    天津: '天津',
    河北: '石家庄',
    山西: '太原',
    内蒙古: '呼和浩特',
    辽宁: '沈阳',
    吉林: '长春',
    黑龙江: '哈尔滨',
    上海: '上海',
    江苏: '南京',
    浙江: '杭州',
    安徽: '合肥',
    福建: '福州',
    江西: '南昌',
    山东: '济南',
    河南: '郑州',
    湖北: '武汉',
    湖南: '长沙',
    广东: '广州',
    广西: '南宁',
    海南: '海口',
    重庆: '重庆',
    四川: '成都',
    贵州: '贵阳',
    云南: '昆明',
    西藏: '拉萨',
    陕西: '西安',
    甘肃: '兰州',
    青海: '西宁',
    宁夏: '银川',
    新疆: '乌鲁木齐',
    香港: '香港',
    澳门: '澳门',
    台湾: '台北',
  };
  const state = {
    authorization: null,
    authorizationWaiters: [],
    template: readJson(STORAGE_KEY),
    lockedTargetIds: readJson(TARGETS_KEY) || [],
    recording: false,
    recordingMode: 'config',
    recordingBaseline: null,
    recordedMutationPayload: null,
    panelOpen: false,
    preview: null,
    lastBatchResult: null,
    sceneDraft: '',
    sceneParseResult: null,
    virtualRealDefaultRows: readVirtualRealDefaultRows(),
    running: false,
    notice: '',
    businessCatalog: null,
  };

  patchFetch();
  patchXhr();
  boot();

  function boot() {
    // Do not wait for NiuLink's often-delayed DOMContentLoaded event.
    const mountWhenBodyReady = () => {
      if (document.body) {
        mount();
        return;
      }
      requestAnimationFrame(mountWhenBodyReady);
    };
    mountWhenBodyReady();
  }

  function log(...args) {
    console.log(`[${NAME}]`, ...args);
  }

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch (_) {
      return null;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function patchFetch() {
    if (window.__nlnfmFetchPatched || typeof window.fetch !== 'function') return;
    const original = window.fetch;
    window.fetch = function patchedFetch(input, init) {
      captureAuthorization(getHeader(init?.headers, 'authorization') || getHeader(input?.headers, 'authorization'));
      const result = original.apply(this, arguments);
      const url = typeof input === 'string' ? input : input?.url;
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (isRecordedMasterMutation(url, method)) {
        Promise.resolve(result).then((response) => {
          if (response?.ok) void recordMasterOperation(url, method, init?.body);
        }).catch(() => null);
      }
      return result;
    };
    Object.defineProperty(window, '__nlnfmFetchPatched', { value: true });
  }

  function patchXhr() {
    if (XMLHttpRequest.prototype.__nlnfmXhrPatched) return;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__nlnfmHeaders = {};
      this.__nlnfmMethod = String(method || 'GET').toUpperCase();
      this.__nlnfmUrl = String(url || '');
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
      this.__nlnfmHeaders ||= {};
      this.__nlnfmHeaders[String(name).toLowerCase()] = value;
      return originalSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function patchedSend() {
      captureAuthorization(this.__nlnfmHeaders?.authorization);
      if (isRecordedMasterMutation(this.__nlnfmUrl, this.__nlnfmMethod)) {
        this.__nlnfmBody = arguments[0];
        this.addEventListener('loadend', () => {
          if (this.status >= 200 && this.status < 300) void recordMasterOperation(this.__nlnfmUrl, this.__nlnfmMethod, this.__nlnfmBody);
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
    Object.defineProperty(XMLHttpRequest.prototype, '__nlnfmXhrPatched', { value: true });
  }

  function getHeader(headers, key) {
    if (!headers) return null;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(key);
    if (Array.isArray(headers)) {
      const entry = headers.find(([name]) => String(name).toLowerCase() === key);
      return entry?.[1] || null;
    }
    if (typeof headers === 'object') {
      const name = Object.keys(headers).find((item) => item.toLowerCase() === key);
      return name ? headers[name] : null;
    }
    return null;
  }

  function isRecordedMasterMutation(url, method) {
    if (!state.recording || method !== 'PUT' || !state.template?.nodeId) return false;
    const path = String(url || '');
    const base = `${NODE_API}${state.template.nodeId}`;
    if (state.recordingMode === 'business') return path.includes(`${base}/switchcustomer`);
    if (state.recordingMode === 'acceptance-miner') return path.includes(`${base}/acceptance`);
    if (state.recordingMode === 'acceptance-internal') return path.includes(`${base}/acceptance`);
    return path.includes(`${base}/schedule`) || path.includes(`${base}/dataedit`);
  }

  async function recordMasterOperation(url, method, body) {
    if (!state.recording || !state.template || !state.lockedTargetIds.length) return;
    const endpoint = String(url || '').includes('/switchcustomer') ? 'business' : String(url || '').includes('/acceptance') ? 'acceptance' : String(url || '').includes('/schedule') ? 'schedule' : 'dataedit';
    state.recording = false;
    try {
      begin('主节点操作已成功，正在读取新配置...');
      state.recordedMutationPayload = parseRecordedMutationPayload(body);
      const after = await getNode(state.template.nodeId);
      const before = state.recordingBaseline || after;
      if (endpoint === 'business') {
        const nominal = after.nominalInfo || {};
        // The mutation payload is authoritative when the follow-up detail read is eventually consistent.
        const recorded = state.recordedMutationPayload || {};
        const realCustomerIds = normalizeBusinessIds(recorded.suggestCustomers || nominal.suggestCustomers || []);
        const virtualCustomerIds = normalizeBusinessIds(recorded.virtualCustomers || nominal.virtualCustomers || []);
        if (!realCustomerIds.length) throw new Error('未从主节点成功结果中识别到目标真实业务。');
        finish('主节点业务切换已成功。请为从节点填写人工确认的需求单映射。');
        await openBusinessSwitchDialog({
          realCustomerIds,
          virtualCustomerIds,
          uncensoredRollBack: Boolean(recorded.uncensoredRollBack),
        });
        return;
      }
      if (endpoint === 'acceptance') {
        const initiator = state.recordingMode === 'acceptance-internal' ? '内部' : '矿主';
        const masterVirtualCustomers = normalizeBusinessIds((after.nominalInfo || {}).virtualCustomers || []);
        const acceptancePreview = await buildAcceptancePreview(state.lockedTargetIds, initiator, masterVirtualCustomers);
        const virtualNotice = masterVirtualCustomers.length ? `，将同步 ${masterVirtualCustomers.length} 个虚拟业务` : '';
        finish(`主节点强制验收已成功，已生成 ${initiator}发起的从节点预检${virtualNotice}。`);
        showBatchActionPreview(`主节点成功后的强制验收（${initiator}发起）`, acceptancePreview, async () => {
          const results = await mapConcurrent(acceptancePreview.ready, WRITE_CONCURRENCY, async (item) => {
            try { await put(`${NODE_API}${item.nodeId}/acceptance`, buildAcceptancePayload(item.detail, initiator, masterVirtualCustomers)); return { nodeId: item.nodeId, ok: true }; }
            catch (error) { return { nodeId: item.nodeId, ok: false, error: message(error) }; }
          });
          finishBatchAction('主节点验收跟随', results);
        });
        return;
      }
      const changes = detectRecordedChanges(before, after, endpoint);
      if (!Object.values(changes).some(Boolean)) {
        finish('未检测到可跟随字段变化，未创建从节点任务。');
        return;
      }
      state.template.source = extractTemplate(after);
      state.template.capturedAt = new Date().toISOString();
      state.template.options = { schedule: changes.schedule, ipSchedule: changes.ipSchedule, networkType: changes.networkType, boardParams: changes.boardParams };
      writeJson(STORAGE_KEY, state.template);
      state.recordingBaseline = null;
      finish('已捕获主节点操作，正在异步预览从节点差异...');
      await previewTargets(state.lockedTargetIds);
    } catch (error) {
      finish(`主节点操作已成功，但跟随预检失败：${message(error)}`);
    }
  }

  function detectRecordedChanges(before, after, endpoint) {
    const beforeNominal = before?.nominalInfo || {};
    const afterNominal = after?.nominalInfo || {};
    return {
      schedule: endpoint === 'schedule' && !equal(before?.schedules === null ? null : (before?.schedules || []), after?.schedules === null ? null : (after?.schedules || [])),
      ipSchedule: endpoint === 'dataedit' && Boolean(beforeNominal.isIPv6Schedule) !== Boolean(afterNominal.isIPv6Schedule),
      networkType: endpoint === 'dataedit' && String(beforeNominal.natType || '') !== String(afterNominal.natType || ''),
      boardParams: endpoint === 'dataedit' && (
        !equal((before?.nodeQosKillerConfig || {}).args || '', (after?.nodeQosKillerConfig || {}).args || '') ||
        !equal((before?.nodeUdpQosKillerConfig || {}).args || '', (after?.nodeUdpQosKillerConfig || {}).args || '')
      ),
    };
  }

  function captureAuthorization(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token) return;
    state.authorization = token;
    state.authorizationWaiters.splice(0).forEach((resolve) => resolve(token));
  }

  function waitForAuthorization(timeout = 2500) {
    if (state.authorization) return Promise.resolve(state.authorization);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(state.authorization), timeout);
      state.authorizationWaiters.push((value) => {
        window.clearTimeout(timer);
        resolve(value);
      });
    });
  }

  function mount() {
    injectStyle();
    render();
    document.addEventListener('input', (event) => {
      if (!event.target.closest?.(`#${ROOT_ID}`)) return;
      const sceneInput = event.target.closest?.('[data-scene-input]');
      if (sceneInput) state.sceneDraft = sceneInput.value;
      const defaultsInput = event.target.closest?.('[data-virtual-real-default-virtual], [data-virtual-real-default-real]');
      if (defaultsInput) {
        const row = defaultsInput.closest?.('[data-virtual-real-default-row]');
        const index = Number(row?.dataset.defaultRowIndex);
        if (!Number.isInteger(index) || !state.virtualRealDefaultRows[index]) return;
        const nextRows = state.virtualRealDefaultRows.map((item, itemIndex) => itemIndex === index
          ? {
              ...item,
              [defaultsInput.hasAttribute('data-virtual-real-default-virtual') ? 'virtualToken' : 'realToken']: defaultsInput.value,
            }
          : item);
        state.virtualRealDefaultRows = normalizeVirtualRealDefaultRows(nextRows);
        state.sceneParseResult = null;
        writeJson(VIRTUAL_REAL_DEFAULTS_KEY, state.virtualRealDefaultRows);
      }
    }, true);
    document.addEventListener('change', (event) => {
      if (!event.target.closest?.(`#${ROOT_ID}`)) window.setTimeout(render, 0);
    }, true);
    let placementQueued = false;
    new MutationObserver(() => {
      if (placementQueued) return;
      placementQueued = true;
      requestAnimationFrame(() => {
        placementQueued = false;
        const root = document.getElementById(ROOT_ID);
        if (root) placeInTopNavigation(root);
        else render();
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function render() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('aside');
      root.id = ROOT_ID;
      document.body.appendChild(root);
      root.addEventListener('click', onClick);
    }
    root.dataset.version = VERSION;
    window.NiuLinkNodeFollowMasterVersion = VERSION;
    placeInTopNavigation(root);
    const template = state.template;
    const selectedCount = selectedNodeIds().length;
    const summary = template
      ? `${escapeHtml(template.nodeName || shortId(template.nodeId))} · ${escapeHtml(template.nodeId)}`
      : '尚未选择主节点';
    const options = template?.options || DEFAULT_OPTIONS;
    const failedBatchItems = failedLastBatchItems();
    const failureActions = failedBatchItems.length
      ? `<div class="nlnfm-failure-actions"><button data-action="show-failure-details">失败明细</button><button data-action="copy-failure-ids">复制失败ID</button></div>`
      : '';
    root.innerHTML = `
      <button class="nlnfm-top-button" data-action="toggle" title="NiuLink 节点跟随 v${VERSION}">
        <span class="nlnfm-top-icon">⚙</span><span>节点跟随</span><small>v${VERSION}</small><b>已选 ${selectedCount}</b>
      </button>
      ${state.panelOpen ? `
        <div class="nlnfm-mask" data-action="toggle"></div>
        <section class="nlnfm-workbench" aria-label="批量节点跟随">
          <header class="nlnfm-workbench-head">
            <div><strong>批量节点跟随</strong><span>以主节点为模板，先预览差异，再同步已勾选的从节点。</span></div>
            <button class="nlnfm-close" data-action="toggle" title="关闭">×</button>
          </header>
          <div class="nlnfm-metrics">
            <span class="nlnfm-chip nlnfm-chip-blue">已选 ${selectedCount}</span>
            <span class="nlnfm-chip">已锁定 ${state.lockedTargetIds.length}</span>
            <span class="nlnfm-chip nlnfm-chip-green">可执行 ${state.preview?.changed || 0}</span>
            <span class="nlnfm-chip">已一致 ${state.preview?.same || 0}</span>
            <span class="nlnfm-chip nlnfm-chip-warn">失败 ${state.preview?.failed || 0}</span>
            <i></i><em>${state.running ? '执行中' : state.recording ? '录制中' : '待预览'}</em>
          </div>
          <div class="nlnfm-body">
            <section class="nlnfm-master-card">
              <div><span>主节点模板</span><strong>${summary}</strong><small>${template ? `读取时间：${escapeHtml(new Date(template.capturedAt).toLocaleString())}` : '先从列表中单选一个节点作为主节点'}</small></div>
              <div class="nlnfm-actions"><button data-action="master-selected">从已选节点里设置主节点</button></div>
            </section>
            <section class="nlnfm-config-card">
              <span class="nlnfm-section-label">跟随项目</span>
              <div class="nlnfm-option-pills">
                <label class="${options.schedule ? 'nlnfm-selected' : ''}"><input type="checkbox" data-option="schedule" ${options.schedule ? 'checked' : ''}>调度时间</label>
                <label class="${options.ipSchedule ? 'nlnfm-selected' : ''}"><input type="checkbox" data-option="ipSchedule" ${options.ipSchedule ? 'checked' : ''}>IP 调度</label>
                <label class="${options.networkType ? 'nlnfm-selected' : ''}"><input type="checkbox" data-option="networkType" ${options.networkType ? 'checked' : ''}>网络类型</label>
                <label class="${options.boardParams ? 'nlnfm-selected' : ''}"><input type="checkbox" data-option="boardParams" ${options.boardParams ? 'checked' : ''}>TCP/UDP 板卡参数</label>
              </div>
              <p>操作目标：${state.lockedTargetIds.length ? `已锁定 <b>${state.lockedTargetIds.length}</b> 个从节点` : `当前已勾选 <b>${selectedCount}</b> 个节点`}；主节点会自动排除。</p>
              <div class="nlnfm-actions nlnfm-record-actions"><button data-action="lock-targets">锁定已勾选为从节点</button><button data-action="clear-targets" ${state.lockedTargetIds.length ? '' : 'disabled'}>清空锁定</button><button data-action="record-master" ${template && state.lockedTargetIds.length ? '' : 'disabled'}>${state.recording ? '正在录制下一次操作' : '开启主节点操作录制'}</button></div>
              <div class="nlnfm-scene-box">
                <span class="nlnfm-section-label">场景语言</span>
                <textarea class="nlnfm-scene-input" data-scene-input placeholder="例如：c4ea191ad5390d04112cafe06e737091 切 z2 | 先预览">${escapeHtml(state.sceneDraft)}</textarea>
                <div class="nlnfm-actions nlnfm-record-actions">
                  <button data-action="parse-scene">解析场景</button>
                  <button data-action="scene-follow" ${state.sceneParseResult?.nodeIds?.length ? '' : 'disabled'}>按解析继续</button>
                  <button data-action="apply-scene" ${state.sceneParseResult?.nodeIds?.length ? '' : 'disabled'}>锁定解析节点</button>
                  <button data-action="clear-scene" ${state.sceneDraft || state.sceneParseResult ? '' : 'disabled'}>清空</button>
                </div>
                <p class="nlnfm-scene-summary">${escapeHtml(describeSceneParseResult(state.sceneParseResult))}</p>
              </div>
              <div class="nlnfm-scene-box">
                <span class="nlnfm-section-label">虚拟业务默认真实业务</span>
                <table class="nlnfm-default-business-table" aria-label="虚拟业务默认真实业务">
                  <thead>
                    <tr><th>虚拟业务</th><th>真实业务</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    ${state.virtualRealDefaultRows.length ? state.virtualRealDefaultRows.map((row, index) => `
                      <tr data-virtual-real-default-row data-default-row-index="${index}">
                        <td><input type="text" data-virtual-real-default-virtual value="${escapeHtml(row.virtualToken || '')}" placeholder="例如：聚宝盆"></td>
                        <td><input type="text" data-virtual-real-default-real value="${escapeHtml(row.realToken || '')}" placeholder="例如：k9异网联通"></td>
                        <td><button type="button" class="nlnfm-default-business-remove" data-action="remove-default-business-row" data-default-row-index="${index}" title="删除这一行">×</button></td>
                      </tr>`).join('') : '<tr><td colspan="3" class="nlnfm-default-business-empty">还没有配置，先新增一行。</td></tr>'}
                  </tbody>
                </table>
                <div class="nlnfm-actions nlnfm-record-actions">
                  <button data-action="add-default-business-row">新增一行</button>
                  <button data-action="reset-default-business-rows" ${state.virtualRealDefaultRows.length ? '' : 'disabled'}>恢复默认</button>
                </div>
                <p class="nlnfm-scene-summary">场景只写虚拟业务时，按这里的默认映射补齐真实业务。</p>
              </div>
            </section>
          </div>
          <footer class="nlnfm-workbench-foot">
            <div class="nlnfm-status-wrap"><div class="nlnfm-status">${escapeHtml(state.notice || previewSummary())}</div>${failureActions}</div>
            <div class="nlnfm-actions nlnfm-primary"><button data-action="preview" ${template ? '' : 'disabled'}>预览差异</button><button data-action="apply" ${state.preview?.ready ? '' : 'disabled'}>确认批量执行</button></div>
          </footer>
          <div class="nlnfm-special-actions"><span>目标业务</span><button data-action="manual-switch-business" ${state.lockedTargetIds.length || selectedCount ? '' : 'disabled'}>自选业务切换</button><button data-action="manual-resubmit-business" ${state.lockedTargetIds.length || selectedCount ? '' : 'disabled'}>自选业务重提</button></div>
          <details><summary>安全规则</summary><p>业务切换仅支持 censored/inService，从主节点读取完整真实/虚拟目标但只写从节点；重新提交仅支持 uncensored。所有操作默认 dry-run、逐节点匹配独立需求单，并在写入前重新验证。</p></details>
        </section>` : ''}`;
  }

  function placeInTopNavigation(root) {
    const accountControl = findAccountControl();
    if (accountControl?.parentElement) {
      root.dataset.nlnfmPlacement = 'nav';
      if (root.parentElement !== accountControl.parentElement || root.nextElementSibling !== accountControl) {
        accountControl.parentElement.insertBefore(root, accountControl);
      }
      return;
    }
    root.dataset.nlnfmPlacement = 'fixed';
    if (root.parentElement !== document.body) document.body.appendChild(root);
  }

  function findAccountControl() {
    const candidates = Array.from(document.querySelectorAll('header *, [class*="header"] *, [class*="navbar"] *'))
      .filter((element) => element.children.length === 0 && isVisible(element) && looksLikeAccountText(element.textContent));
    const accountText = candidates.at(-1);
    if (!accountText) return null;
    let control = accountText;
    for (let index = 0; index < 4 && control.parentElement; index += 1) {
      const parent = control.parentElement;
      const rect = parent.getBoundingClientRect();
      if (rect.width > accountText.getBoundingClientRect().width && rect.height <= 80) control = parent;
      else break;
    }
    return control;
  }

  function looksLikeAccountText(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function previewSummary() {
    if (!state.preview) return '请先选择主节点和从节点。';
    const { targets = [], changed = 0, same = 0, failed = 0 } = state.preview;
    return `预览 ${targets.length} 个从节点：${changed} 个有差异，${same} 个已一致，${failed} 个读取失败。`;
  }

  async function parseSceneDraft() {
    const result = parseSceneLanguage(state.sceneDraft || '');
    state.sceneParseResult = result;
    render();
    if (result.targetBusinesses?.length) {
      try {
        result.resolvedTarget = await resolveSceneBusinessTarget(result.targetBusinesses);
      } catch (error) {
        result.resolvedTarget = { realCustomerIds: [], virtualCustomerIds: [], unresolvedTokens: result.targetBusinesses, error: message(error) };
      }
    }
    state.sceneParseResult = result;
    state.notice = result.nodeIds.length
      ? '已解析场景：' + result.nodeIds.length + ' 个节点，动作 ' + (result.actionLabel || '未识别') + '。'
      : '未解析到节点ID。';
    render();
    return result;
  }
  function applySceneDraft() {
    const result = state.sceneParseResult || parseSceneLanguage(state.sceneDraft || '');
    state.sceneParseResult = result;
    if (!result.nodeIds.length) return setNotice('没有解析到节点ID，无法锁定。');
    state.lockedTargetIds = result.nodeIds;
    writeJson(TARGETS_KEY, state.lockedTargetIds);
    state.notice = `已锁定解析出的 ${result.nodeIds.length} 个节点。`;
    render();
    return result;
  }
  async function followSceneDraft(autoParse = false) {
    const result = autoParse ? parseSceneLanguage(state.sceneDraft || '') : (state.sceneParseResult || parseSceneLanguage(state.sceneDraft || ''));
    state.sceneParseResult = result;
    if (!result.nodeIds.length) return setNotice('没有解析到节点ID，无法继续。');
    const ids = result.nodeIds;
    const sceneTarget = result.resolvedTarget || await resolveSceneBusinessTarget(result.targetBusinesses || []);
    result.resolvedTarget = sceneTarget;
    const mode = result.action === 'business_resubmit' ? 'resubmit' : 'switch';
    state.lockedTargetIds = ids;
    writeJson(TARGETS_KEY, state.lockedTargetIds);
    render();
    if (!sceneTarget.realCustomerIds.length) {
      setNotice('已锁定节点，但还没有识别到目标业务，已打开手动选择器。');
      await openManualBusinessTargetDialog(mode);
      return;
    }
    finish(`已按场景语言识别 ${ids.length} 个节点和目标业务，正在进入需求单预检。`);
    await showBusinessDemandDialog(ids, sceneTarget, { mode, targetSource: 'scene-language', autoQuery: true });
  }
  function clearSceneDraft() {
    state.sceneDraft = '';
    state.sceneParseResult = null;
    render();
    setNotice('已清空场景语言输入。');
  }

  function addVirtualRealDefaultRow() {
    state.virtualRealDefaultRows = normalizeVirtualRealDefaultRows([
      ...(state.virtualRealDefaultRows || []),
      { virtualToken: '', realToken: '' },
    ]);
    state.sceneParseResult = null;
    writeJson(VIRTUAL_REAL_DEFAULTS_KEY, state.virtualRealDefaultRows);
    render();
  }

  function resetVirtualRealDefaultRows() {
    state.virtualRealDefaultRows = clone(DEFAULT_VIRTUAL_REAL_DEFAULTS_ROWS);
    state.sceneParseResult = null;
    writeJson(VIRTUAL_REAL_DEFAULTS_KEY, state.virtualRealDefaultRows);
    render();
    setNotice('已恢复默认虚拟业务映射。');
  }

  function removeVirtualRealDefaultRow(button) {
    const index = Number(button?.dataset?.defaultRowIndex);
    if (!Number.isInteger(index)) return;
    const nextRows = (state.virtualRealDefaultRows || []).filter((_, itemIndex) => itemIndex !== index);
    state.virtualRealDefaultRows = normalizeVirtualRealDefaultRows(nextRows);
    state.sceneParseResult = null;
    writeJson(VIRTUAL_REAL_DEFAULTS_KEY, state.virtualRealDefaultRows);
    render();
  }

  function parseSceneLanguage(text) {
    const raw = String(text || '').replace(/\u00a0/g, ' ').trim();
    const nodeIds = Array.from(new Set((raw.match(/\b[a-f0-9]{32}\b/gi) || []).map((value) => value.toLowerCase())));
    const compact = raw.replace(/\b[a-f0-9]{32}\b/gi, ' ').replace(/[|]/g, ' | ');
    const actionLabel = detectSceneAction(compact);
    const flags = detectSceneFlags(compact);
    const targetBusinesses = extractSceneTargetBusinesses(compact, actionLabel);
    return {
      raw,
      nodeIds,
      action: actionLabel ? actionLabel.action : null,
      actionLabel: actionLabel ? actionLabel.label : null,
      targetBusinesses,
      ...flags,
    };
  }

  function detectSceneAction(text) {
    const lower = String(text || '').toLowerCase();
    if (/(帮忙|帮我|给我|要不|这个|这几个|这些|都)?\s*(切换|切到|切|转业务|转为|转成|调整为|调整到|调整|调成|改成|改为|换成)/.test(lower)) {
      return { label: '切换业务', action: 'business_switch' };
    }
    const tokens = [
      { label: '重新提交', action: 'business_resubmit', patterns: ['重提', '重新提交', '重提交'] },
      { label: '匹配需求单', action: 'demand_match', patterns: ['匹配', '找需求', '找单', '需求匹配'] },
      { label: '清除上报', action: 'reporting_clear', patterns: ['清除', '清空', '删除上报', '清上报'] },
      { label: '同步上报', action: 'reporting_sync', patterns: ['同步', '上报同步', '同步上报'] },
      { label: '预览', action: 'preview_only', patterns: ['预览', '先看', '只看'] },
      { label: '执行', action: 'execute', patterns: ['执行', '提交', '确认'] },
    ];
    for (const token of tokens) {
      if (token.patterns.some((pattern) => lower.includes(pattern.toLowerCase()))) return token;
    }
    return null;
  }
  function detectSceneFlags(text) {
    return {
      dryRun: /预览|先看|只看/.test(text),
      syncReporting: /同步|上报/.test(text),
      clearReporting: /清除|清空|删除上报|清上报/.test(text),
      allowReuseDemand: /复用|共用|共享/.test(text),
      requireConfirm: !/直接执行|立即执行|自动执行/.test(text),
    };
  }

  function extractSceneTargetBusinesses(text, actionLabel = null) {
    const source = String(text || '').replace(/\u00a0/g, ' ');
    const actionTargets = [];
    const actionPattern = /(切换|切到|切|转业务|转为|转成|调整为|调整到|调整|调成|改成|改为|换成)\s*([^|。！？\n\r]{1,100})/g;
    let match;
    while ((match = actionPattern.exec(source))) {
      const cleaned = cleanSceneBusinessToken(match[2]);
      if (cleaned) actionTargets.push(cleaned);
    }
    if (actionTargets.length) return normalizeSceneBusinessTokens(actionTargets);
    let body = source;
    body = body.replace(/[|].*$/g, ' ');
    body = body.replace(/\b[a-f0-9]{32}\b/gi, ' ');
    ['切换', '切到', '转业务', '转为', '转成', '调整为', '调整到', '调整', '调成', '改成', '改为', '换成', '切', '转', '重提', '重新提交', '重提交', '匹配', '找需求', '找单', '需求匹配', '清除', '清空', '删除上报', '清上报', '同步', '上报同步', '同步上报', '预览', '先看', '只看', '执行', '提交', '确认'].forEach((name) => {
      body = body.replace(new RegExp(name, 'g'), ' ');
    });
    body = body.replace(/[，,;；/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!body) return [];
    const tokens = body.split(/[+、\s]+/).map(cleanSceneBusinessToken).filter(Boolean);
    return normalizeSceneBusinessTokens(tokens);
  }

  function cleanSceneBusinessToken(value) {
    let token = String(value || '').replace(/\u00a0/g, ' ').trim();
    token = token.replace(/^(这几个|这些|这个|那些|那个|都|帮忙|帮我|给我|请|麻烦|要不|能不能|可以|把|将)+/g, '');
    token = token.replace(/(看看|看下|一下|吧|吗|呢|业务|节点)+$/g, '');
    token = token.replace(/^(切换|切到|切|调整|调成|改成|改为|换成|转为|转成)+/g, '');
    return token.trim();
  }

  function normalizeSceneBusinessTokens(values) {
    const tokens = [];
    (values || []).forEach((value) => {
      const expanded = expandSceneBusinessTokenCandidates(value).filter((token) => !isSceneControlToken(token));
      const cleaned = cleanSceneBusinessToken(value);
      const splitParts = expanded.filter((token) => token !== cleaned);
      tokens.push(...(splitParts.length > 1 ? splitParts : expanded));
    });
    return Array.from(new Set(tokens.map(cleanSceneBusinessToken).filter((token) => token && !isSceneControlToken(token))));
  }

  function expandSceneBusinessTokenCandidates(value) {
    const cleaned = cleanSceneBusinessToken(value);
    if (!cleaned) return [];
    const normalized = cleaned
      .replace(/[()（）\[\]【】]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const splitText = normalized
      .replace(/([a-zA-Z0-9])的/g, '$1 ')
      .replace(/的([a-zA-Z0-9])/g, ' $1')
      .replace(/(?:以及|和|与|及|[+、/\\,，;；&\s]+)/g, ' ');
    const parts = splitText.split(/\s+/).map(cleanSceneBusinessToken).filter(Boolean);
    return Array.from(new Set([normalized, ...parts].map(cleanSceneBusinessToken).filter(Boolean)));
  }

  function isSceneControlToken(token) {
    return /^(先预览|预览|同步|同步上报|上报|清除|清空|执行|确认|提交|直接执行|立即执行|自动执行|目标业务|业务)$/i.test(String(token || '').trim());
  }

  async function resolveSceneBusinessTarget(targetBusinesses = []) {
    const catalog = await getBusinessCatalog();
    const tokens = Array.from(new Set((targetBusinesses || []).map((value) => String(value || '').trim()).filter(Boolean)));
    const defaultRules = resolveVirtualRealDefaultRules(catalog);
    const realCustomerIds = new Set();
    const virtualCustomerIds = new Set();
    const unresolvedTokens = [];
    const defaultRealMappings = [];
    for (const token of tokens) {
      let matched = false;
      for (const candidate of expandSceneBusinessTokenCandidates(token)) {
        if (isSceneControlToken(candidate)) continue;
        const realMatch = findBusinessIdByToken(candidate, catalog.real, catalog.realSearch);
        const virtualMatch = findBusinessIdByToken(candidate, catalog.virtual, catalog.virtualSearch);
        if (realMatch) {
          realCustomerIds.add(Number(realMatch));
          matched = true;
        }
        if (virtualMatch) {
          virtualCustomerIds.add(Number(virtualMatch));
          matched = true;
          const defaultMapping = findDefaultRealMappingForVirtual(virtualMatch, defaultRules);
          if (defaultMapping?.realId) {
            realCustomerIds.add(Number(defaultMapping.realId));
            defaultRealMappings.push(defaultMapping);
          }
        }
      }
      if (!matched) unresolvedTokens.push(token);
    }
    const mode = virtualCustomerIds.size ? 'switch' : 'switch';
    return {
      mode,
      realCustomerIds: Array.from(realCustomerIds),
      virtualCustomerIds: Array.from(virtualCustomerIds),
      unresolvedTokens,
      defaultRealMappings: dedupeDefaultRealMappings(defaultRealMappings),
    };
  }

  function readVirtualRealDefaultRows() {
    const stored = readJson(VIRTUAL_REAL_DEFAULTS_KEY);
    if (stored == null) return clone(DEFAULT_VIRTUAL_REAL_DEFAULTS_ROWS);
    if (Array.isArray(stored)) return normalizeVirtualRealDefaultRows(stored);
    if (typeof stored === 'string') {
      const parsed = parseVirtualRealDefaultText(stored);
      return parsed.length ? parsed : clone(DEFAULT_VIRTUAL_REAL_DEFAULTS_ROWS);
    }
    return clone(DEFAULT_VIRTUAL_REAL_DEFAULTS_ROWS);
  }

  function parseVirtualRealDefaultText(text) {
    return normalizeVirtualRealDefaultRows(
      String(text || '')
        .split(/\n+/)
        .map((line) => line.replace(/#.*/g, '').trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s*(?:=>|->|=|:|：)\s*/).map((part) => part.trim()).filter(Boolean);
          if (parts.length < 2) return null;
          return { virtualToken: parts[0], realToken: parts.slice(1).join(' ') };
        })
        .filter(Boolean)
    );
  }

  function normalizeVirtualRealDefaultRow(row = {}) {
    const virtualToken = String(row.virtualToken || row.virtual || row.virtualName || row.left || '').replace(/\u00a0/g, ' ').trim();
    const realToken = String(row.realToken || row.real || row.realName || row.right || '').replace(/\u00a0/g, ' ').trim();
    return { virtualToken, realToken };
  }

  function normalizeVirtualRealDefaultRows(rows) {
    return (Array.isArray(rows) ? rows : []).map(normalizeVirtualRealDefaultRow);
  }

  function parseVirtualRealDefaultRules(rows = state.virtualRealDefaultRows) {
    return normalizeVirtualRealDefaultRows(rows).filter((row) => row.virtualToken && row.realToken);
  }

  function resolveVirtualRealDefaultRules(catalog) {
    return parseVirtualRealDefaultRules()
      .map((rule) => {
        const virtualId = findBusinessIdByToken(rule.virtualToken, catalog.virtual, catalog.virtualSearch);
        const realId = findBusinessIdByToken(rule.realToken, catalog.real, catalog.realSearch);
        return virtualId && realId ? { ...rule, virtualId: String(virtualId), realId: String(realId) } : null;
      })
      .filter(Boolean);
  }

  function findDefaultRealMappingForVirtual(virtualId, rules) {
    return (rules || []).find((rule) => String(rule.virtualId) === String(virtualId)) || null;
  }

  function dedupeDefaultRealMappings(mappings) {
    const seen = new Set();
    return (mappings || []).filter((item) => {
      const key = `${item.virtualId}:${item.realId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function findBusinessIdByToken(token, names, searchIndex) {
    const raw = String(token || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
    const variants = Array.from(new Set([
      raw,
      cleanSceneBusinessToken(raw).toLowerCase(),
      raw.replace(/业务$/g, ''),
      raw.replace(/(看看|看下|一下|吧|吗|呢)$/g, ''),
    ].map((item) => String(item || '').trim()).filter(Boolean)));
    for (const keyword of variants) {
      if (names?.has(keyword)) return keyword;
      for (const [id, name] of (names || new Map()).entries()) {
        const haystack = String(searchIndex?.get(String(id)) || `${name} ${id}`).toLowerCase();
        if (haystack === keyword || haystack.includes(keyword) || keyword.includes(haystack)) return String(id);
      }
    }
    return null;
  }
  function describeSceneParseResult(result) {
    if (!result) return '请输入“节点ID 动作 目标业务 | 备注”并点击解析。';
    const nodeText = result.nodeIds.length ? result.nodeIds.join('，') : '未识别节点';
    const actionText = result.actionLabel || '未识别动作';
    const resolved = result.resolvedTarget || null;
    const realText = resolved?.realCustomerIds?.length ? formatBusinessNames(resolved.realCustomerIds, state.businessCatalog?.real) : '未识别';
    const virtualText = resolved?.virtualCustomerIds?.length ? formatBusinessNames(resolved.virtualCustomerIds, state.businessCatalog?.virtual) : '不设置/未识别';
    const unresolvedText = resolved?.unresolvedTokens?.length ? resolved.unresolvedTokens.join(' + ') : '';
    const defaultText = resolved?.defaultRealMappings?.length ? formatDefaultRealMappings(resolved.defaultRealMappings, state.businessCatalog) : '';
    const fallbackTargetText = result.targetBusinesses?.length ? result.targetBusinesses.join(' + ') : '未识别目标业务';
    const nextStep = result.nodeIds.length && result.targetBusinesses?.length
      ? '进入需求单预检'
      : result.nodeIds.length
        ? '进入业务选择器'
        : '补充节点ID';
    const flagText = [
      result.dryRun ? '预览' : '',
      result.syncReporting ? '同步上报' : '',
      result.clearReporting ? '清除上报' : '',
      result.allowReuseDemand ? '允许复用需求单' : '',
    ].filter(Boolean).join(' · ');
    const rows = [
      '节点：' + nodeText,
      '动作：' + actionText,
      resolved ? '真实业务：' + realText : '目标：' + fallbackTargetText,
      resolved ? '虚拟业务：' + virtualText : '',
      defaultText ? '默认补齐：' + defaultText : '',
      unresolvedText ? '未识别：' + unresolvedText : '',
      '下一步：' + nextStep,
      flagText ? '约束：' + flagText : '',
    ];
    return rows.filter(Boolean).join('\n');
  }
  async function onClick(event) {
    const option = event.target.closest?.('[data-option]');
    if (option) {
      updateTemplateOptions({ [option.dataset.option]: option.checked });
      return;
    }
    const button = event.target.closest?.('[data-action]');
    if (!button || button.disabled || state.running) return;
    const action = button.dataset.action;
    if (action === 'toggle') {
      state.panelOpen = !state.panelOpen;
      render();
      return;
    }
    if (action === 'master-selected') return setMasterFromSelected();
    if (action === 'lock-targets') return lockSelectedTargets();
    if (action === 'clear-targets') return clearLockedTargets();
    if (action === 'record-master') return startMasterRecording();
    if (action === 'manual-switch-business') return openManualBusinessTargetDialog('switch');
    if (action === 'manual-resubmit-business') return openManualBusinessTargetDialog('resubmit');
    if (action === 'show-failure-details') return showFailureDetails();
    if (action === 'copy-failure-ids') return copyFailedNodeIds(button);
    if (action === 'switch-business') return openBusinessSwitchFromMasterDialog();
    if (action === 'resubmit-business') return openBusinessResubmitDialog();
    if (action === 'record-business') return startMasterRecording('business');
    if (action === 'record-acceptance-miner') return startMasterRecording('acceptance-miner');
    if (action === 'record-acceptance-internal') return startMasterRecording('acceptance-internal');
    if (action === 'add-default-business-row') return addVirtualRealDefaultRow();
    if (action === 'reset-default-business-rows') return resetVirtualRealDefaultRows();
    if (action === 'remove-default-business-row') return removeVirtualRealDefaultRow(button);
    if (action === 'preview') return previewTargets();
    if (action === 'apply') return applyPreview();
    if (action === 'parse-scene') return parseSceneDraft();
    if (action === 'scene-follow') return followSceneDraft(true);
    if (action === 'apply-scene') return applySceneDraft();
    if (action === 'clear-scene') return clearSceneDraft();
  }

  function updateTemplateOptions(next) {
    if (!state.template) return;
    state.template.options = { ...DEFAULT_OPTIONS, ...state.template.options, ...next };
    writeJson(STORAGE_KEY, state.template);
    state.preview = null;
    render();
  }

  async function setMasterFromSelected() {
    const nodes = selectedNodeRecords();
    if (!nodes.length) return setNotice('请先在列表勾选节点。');
    if (nodes.length === 1) return setMasterAndFollowers(nodes[0].nodeId, nodes);
    showMasterPicker(nodes);
  }

  async function setMaster(nodeId) {
    try {
      begin('正在读取主节点配置...');
      const detail = await getNode(nodeId);
      state.template = {
        version: 1,
        nodeId,
        nodeName: String(detail.nodeName || detail.name || detail.nodeID || nodeId),
        capturedAt: new Date().toISOString(),
        options: { ...DEFAULT_OPTIONS },
        source: extractTemplate(detail),
      };
      state.recordingBaseline = detail;
      writeJson(STORAGE_KEY, state.template);
      state.preview = null;
      finish(`已设为主节点：${state.template.nodeName}`);
      return true;
    } catch (error) {
      finish(`读取主节点失败：${message(error)}`);
      return false;
    }
  }

  async function setMasterAndFollowers(nodeId, nodes) {
    const didSetMaster = await setMaster(nodeId);
    if (!didSetMaster) return;
    state.lockedTargetIds = nodes.map((item) => item.nodeId).filter((id) => id !== nodeId);
    if (state.lockedTargetIds.length) writeJson(TARGETS_KEY, state.lockedTargetIds);
    else localStorage.removeItem(TARGETS_KEY);
    state.preview = null;
    setNotice(`已设定主节点，其余 ${state.lockedTargetIds.length} 个已选节点已自动作为从节点锁定。`);
  }

  function showMasterPicker(nodes) {
    document.getElementById('nlnfm-master-picker')?.remove();
    const picker = document.createElement('section');
    picker.id = 'nlnfm-master-picker';
    picker.innerHTML = `
      <div class="nlnfm-dialog-head"><strong>从已选节点中选择主节点</strong><button data-close-master-picker>×</button></div>
      <p>其余已选节点会自动锁定为从节点。</p>
      <div class="nlnfm-master-list">${nodes.map((node, index) => `
        <label><input type="radio" name="nlnfm-master" value="${escapeHtml(node.nodeId)}" ${index === 0 ? 'checked' : ''}>
        <span>${escapeHtml(node.nodeName)}</span><code>${escapeHtml(node.nodeId)}</code></label>`).join('')}</div>
      <footer><button data-close-master-picker>取消</button><button class="nlnfm-picker-confirm" data-confirm-master-picker>设为主节点</button></footer>`;
    picker.addEventListener('click', async (event) => {
      if (event.target.closest('[data-close-master-picker]')) return picker.remove();
      if (!event.target.closest('[data-confirm-master-picker]')) return;
      const nodeId = picker.querySelector('input[name="nlnfm-master"]:checked')?.value;
      if (!nodeId) return;
      picker.remove();
      await setMasterAndFollowers(nodeId, nodes);
    });
    document.body.appendChild(picker);
  }

  function lockSelectedTargets() {
    const ids = selectedNodeIds().filter((nodeId) => nodeId !== state.template?.nodeId);
    if (!ids.length) return setNotice('请先在列表勾选至少 1 个从节点。');
    if (ids.length > MAX_TARGETS) return setNotice(`首版每次最多锁定 ${MAX_TARGETS} 个从节点。`);
    state.lockedTargetIds = ids;
    writeJson(TARGETS_KEY, ids);
    state.preview = null;
    setNotice(`已锁定 ${ids.length} 个从节点，之后可操作主节点。`);
  }

  function clearLockedTargets() {
    state.lockedTargetIds = [];
    localStorage.removeItem(TARGETS_KEY);
    state.preview = null;
    setNotice('已清空锁定的从节点。');
  }

  async function startMasterRecording(mode = 'config') {
    if (!state.template) return setNotice('请先设置主节点。');
    if (!state.lockedTargetIds.length) return setNotice('请先锁定从节点。');
    try {
      begin('正在读取主节点基线，准备录制下一次操作...');
      state.recordingBaseline = await getNode(state.template.nodeId);
      state.recordingMode = mode;
      state.recordedMutationPayload = null;
      state.recording = true;
      const label = mode === 'business' ? '业务切换' : mode === 'acceptance-miner' ? '矿主发起强制验收' : mode === 'acceptance-internal' ? '内部发起强制验收' : '调度时间、IP 调度或板卡参数';
      finish(`录制已开启：请在主节点完成一次${label}。接口成功后才会创建从节点任务。`);
    } catch (error) {
      finish(`无法开启录制：${message(error)}`);
    }
  }

  function extractTemplate(detail) {
    const nominal = detail.nominalInfo || {};
    return {
      schedules: detail.schedules === null ? null : clone(detail.schedules || []),
      isIPv6Schedule: Boolean(nominal.isIPv6Schedule),
      natType: String(nominal.natType || ''),
      tcpArgs: String((detail.nodeQosKillerConfig || {}).args || ''),
      udpArgs: String((detail.nodeUdpQosKillerConfig || {}).args || ''),
    };
  }

  async function previewTargets(candidateIds = targetIds()) {
    const ids = candidateIds.filter((nodeId) => nodeId !== state.template?.nodeId);
    if (!ids.length) return setNotice('请先勾选至少 1 个从节点。');
    if (ids.length > MAX_TARGETS) return setNotice(`首版每次最多预览 ${MAX_TARGETS} 个从节点，请缩小选择范围。`);
    try {
      begin(`正在读取 ${ids.length} 个从节点...`);
      const targets = await mapConcurrent(ids, 3, async (nodeId) => {
        try {
          const detail = await getNode(nodeId);
          return { nodeId, nodeName: detail.nodeName || detail.name || nodeId, detail, diff: buildDiff(detail) };
        } catch (error) {
          return { nodeId, nodeName: nodeId, error: message(error), diff: [] };
        }
      });
      const changed = targets.filter((item) => !item.error && item.diff.length).length;
      const same = targets.filter((item) => !item.error && !item.diff.length).length;
      const failed = targets.filter((item) => item.error).length;
      state.preview = { targets, changed, same, failed, ready: changed > 0 };
      writeAudit('preview', { masterNodeId: state.template.nodeId, targets: targets.map(briefTarget), changed, same, failed });
      finish(previewSummary());
      showPreviewDialog();
    } catch (error) {
      finish(`预览失败：${message(error)}`);
    }
  }

  function buildDiff(detail) {
    const source = state.template.source;
    const selected = state.template.options;
    const nominal = detail.nominalInfo || {};
    const diff = [];
    if (selected.schedule && !equal(source.schedules, detail.schedules === null ? null : (detail.schedules || []))) {
      diff.push({ key: 'schedule', label: `调度时间：${describeSchedules(detail.schedules)} → ${describeSchedules(source.schedules)}` });
    }
    if (selected.ipSchedule && Boolean(nominal.isIPv6Schedule) !== source.isIPv6Schedule) {
      diff.push({ key: 'ipSchedule', label: `IP 调度：${nominal.isIPv6Schedule ? '仅 v6 调度' : '不限制'} → ${source.isIPv6Schedule ? '仅 v6 调度' : '不限制'}` });
    }
    if (selected.networkType && typeof source.natType === 'string' && String(nominal.natType || '') !== source.natType) {
      diff.push({ key: 'networkType', label: `网络类型：${describeNetworkType(nominal.natType)} → ${describeNetworkType(source.natType)}` });
    }
    if (selected.boardParams) {
      if (!equal((detail.nodeQosKillerConfig || {}).args || '', source.tcpArgs || '')) {
        diff.push({ key: 'tcp', label: 'TCP 板卡参数将同步' });
      }
      if (!equal((detail.nodeUdpQosKillerConfig || {}).args || '', source.udpArgs || '')) {
        diff.push({ key: 'udp', label: 'UDP 板卡参数将同步' });
      }
    }
    return diff;
  }

  function showPreviewDialog() {
    document.getElementById('nlnfm-preview')?.remove();
    const dialog = document.createElement('section');
    dialog.id = 'nlnfm-preview';
    const rows = state.preview.targets.map((target) => `
      <tr class="${target.error ? 'nlnfm-error' : target.diff.length ? 'nlnfm-change' : ''}">
        <td>${escapeHtml(target.nodeName)}</td><td><code>${escapeHtml(shortId(target.nodeId))}</code></td>
        <td>${target.error ? escapeHtml(`读取失败：${target.error}`) : escapeHtml(target.diff.map((item) => item.label).join('；') || '已一致，无需写入')}</td>
      </tr>`).join('');
    dialog.innerHTML = `<div class="nlnfm-dialog-head"><strong>从节点差异预览</strong><button data-close-preview>×</button></div>
      <p>主节点：${escapeHtml(state.template.nodeName)}。只有“有差异”的节点会写入；执行前会再次读取节点详情。</p>
      <div class="nlnfm-table"><table><thead><tr><th>节点</th><th>ID</th><th>差异</th></tr></thead><tbody>${rows}</tbody></table></div>
      <footer>本次将写入 ${state.preview.changed} 个节点。请在右下角面板点击“确认批量执行”。</footer>`;
    dialog.addEventListener('click', (event) => {
      if (event.target.closest('[data-close-preview]')) dialog.remove();
    });
    document.body.appendChild(dialog);
  }

  async function applyPreview() {
    const preview = state.preview;
    if (!preview?.ready || !state.template) return;
    const planned = preview.targets.filter((item) => !item.error && item.diff.length);
    try {
      begin(`正在写入 0/${planned.length}...`);
      let completed = 0;
      const results = await mapConcurrent(planned, WRITE_CONCURRENCY, async (item) => {
        const result = await applyOne(item.nodeId);
        completed += 1;
        state.notice = `正在写入 ${completed}/${planned.length}...`;
        render();
        return result;
      });
      const success = results.filter((item) => item.ok).length;
      const failed = results.length - success;
      writeAudit('apply', { masterNodeId: state.template.nodeId, result: results, success, failed });
      state.preview = null;
      document.getElementById('nlnfm-preview')?.remove();
      finish(`执行完成：成功 ${success}，失败 ${failed}。已回读校验成功节点。`);
    } catch (error) {
      finish(`批量执行中断：${message(error)}`);
    }
  }

  async function applyOne(nodeId) {
    try {
      const before = await getNode(nodeId);
      const diff = buildDiff(before);
      if (!diff.length) return { nodeId, ok: true, skipped: true, reason: 'already_equal' };
      const selected = state.template.options;
      // dataedit carries schedules from the target detail, so it must run before /schedule.
      if (selected.ipSchedule || selected.networkType || selected.boardParams) {
        const payload = buildDataeditPayload(before, state.template.source, selected);
        await put(`${NODE_API}${nodeId}/dataedit`, payload);
      }
      if (selected.schedule && diff.some((item) => item.key === 'schedule')) {
        await put(`${NODE_API}${nodeId}/schedule`, buildSchedulePayload(before, state.template.source.schedules));
      }
      const after = await getNode(nodeId);
      const remaining = buildDiff(after);
      if (remaining.length) throw new Error(`回读校验未通过：${remaining.map((item) => item.key).join(', ')}`);
      return { nodeId, ok: true, skipped: false };
    } catch (error) {
      log('apply failed', nodeId, error);
      return { nodeId, ok: false, error: message(error) };
    }
  }

  function buildSchedulePayload(detail, schedules) {
    const nominal = detail.nominalInfo || {};
    const scheduleIsps = nominal.scheduleISPs || [];
    const isTransIsp = Boolean(scheduleIsps.length);
    return compact({
      isTransProv: Boolean(nominal.isTransProv),
      transProvRate: Number(nominal.transProvRate || 0),
      isIPv6Schedule: Boolean(nominal.isIPv6Schedule),
      schedules: clone(schedules),
      isTransISP: isTransIsp,
      realISPSchedulable: isTransIsp ? nominal.realISPSchedulable : undefined,
      scheduleISPs: isTransIsp ? clone(scheduleIsps) : undefined,
      scheduleISPReason: isTransIsp ? nominal.scheduleISPReason : undefined,
      netSchedule: detail.netSchedule,
      qosThrottling: Boolean(detail.qosThrottling),
      qosKillerWorkingTimes: clone(detail.qosKillerWorkingTimes || []),
    });
  }

  function buildDataeditPayload(detail, source, selected) {
    const current = detail.nominalInfo || {};
    const fields = [
      'province', 'city', 'isp', 'usbw', 'bwNum', 'deployUsbw', 'bandwidth', 'natType', 'dialSource', 'dialType', 'webPort', 'bwRatio', 'deposit',
      'resourceType', 'deliveryType', 'bizProvince', 'bizCity', 'bizIsp', 'acceptLimitBw',
      'isManaged', 'suggestCustomers', 'originTransProvRate', 'scheduleTransProvRate', 'isIPv6Schedule', 'isCloudVm',
      'scheduleISPRules', 'transISPVendorVisable', 'realISPSchedulable', 'scheduleISPs', 'scheduleISPReason', 'isMinorISP',
      'nodeArchType', 'denyAllNetworkSchedule', 'vendorSuggestCustomers', 'virtualCustomers',
    ];
    const nominal = Object.fromEntries(fields.filter((key) => current[key] !== undefined && current[key] !== null).map((key) => [key, clone(current[key])]));
    nominal.scheduleISPRules = Array.isArray(nominal.scheduleISPRules) ? nominal.scheduleISPRules : [];
    if (selected.ipSchedule) nominal.isIPv6Schedule = source.isIPv6Schedule;
    if (selected.networkType && typeof source.natType === 'string') nominal.natType = source.natType;
    return compact({
      nodeID: detail.nodeID,
      nominal,
      editType: 'nominal',
      notes: clone(detail.notes || []),
      tags: clone(detail.tags || []),
      schedules: clone(detail.schedules || []),
      demandId: detail.demandId,
      nodeTags: (detail.nodeTags || []).map((item) => Number(item?.tagId || item?.id || item)).filter(Number.isFinite),
      settlePeriodType: detail.settlePeriodType || detail.currMonthSettlePeriodType || 'month',
      testPeriod: clone(detail.testPeriod || []),
      nodeQosKillerConfig: selected.boardParams ? copyConfigArgs(detail.nodeQosKillerConfig, source.tcpArgs) : clone(detail.nodeQosKillerConfig || {}),
      nodeUdpQosKillerConfig: selected.boardParams ? copyConfigArgs(detail.nodeUdpQosKillerConfig, source.udpArgs) : clone(detail.nodeUdpQosKillerConfig || {}),
      qosKillerWorkingTimes: clone(detail.qosKillerWorkingTimes || []),
      natForwardEnable: Boolean(detail.natForwardEnable),
    });
  }

  async function getNode(nodeId) {
    return request(`${NODE_API}${nodeId}`, { method: 'GET' });
  }

  async function getFreshNode(nodeId) {
    const normalized = normalizeNodeId(nodeId);
    if (!normalized) throw new Error(`无效节点 ID：${nodeId || '--'}`);
    const response = await request(NODE_LIST_API, {
      method: 'POST',
      body: JSON.stringify({ query: normalized, queryType: 'nodeId', nodeType: 'all' }),
    });
    const items = Array.isArray(response?.items) ? response.items : [];
    const detail = items.find((item) => normalizeNodeId(item?.nodeID || item?.nodeId) === normalized);
    if (!detail) throw new Error(`v2 节点列表未返回节点 ${normalized}，已停止写入。`);
    return detail;
  }

  function resolveBusinessTarget(detail, catalog) {
    const nominal = detail?.nominalInfo || {};
    const realCustomerIds = normalizeBusinessIds(nominal.suggestCustomers || []);
    let virtualCustomerIds = normalizeBusinessIds(nominal.virtualCustomers || []);
    let virtualTargetSource = 'target';
    if (!virtualCustomerIds.length) {
      virtualCustomerIds = normalizeBusinessIds(nominal.vendorSuggestCustomers || [])
        .filter((id) => catalog.virtual.has(String(id)));
      if (virtualCustomerIds.length) virtualTargetSource = 'vendor-expectation';
    }
    if (!realCustomerIds.length) throw new Error('主节点没有可读取的目标真实业务。');
    return { realCustomerIds, virtualCustomerIds, virtualTargetSource };
  }

  function buildManualBusinessTarget(realCustomerIds, virtualCustomerIds, catalog) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    if (!realIds.length) throw new Error('请至少选择 1 个真实业务。');
    const unknownReal = realIds.filter((id) => !catalog?.real?.has(String(id)));
    const unknownVirtual = virtualIds.filter((id) => !catalog?.virtual?.has(String(id)));
    if (unknownReal.length) throw new Error(`真实业务不在当前业务目录中：${unknownReal.join('、')}`);
    if (unknownVirtual.length) throw new Error(`虚拟业务不在当前业务目录中：${unknownVirtual.join('、')}`);
    validateVirtualBusinessAssociations(realIds, virtualIds, catalog);
    return {
      realCustomerIds: realIds,
      virtualCustomerIds: virtualIds,
      virtualTargetSource: 'manual',
    };
  }

  function isStackableRealBusinessId(id, catalog) {
    const realId = Number(id);
    if (!Number.isFinite(realId)) return false;
    if (STACKABLE_REAL_BUSINESS_IDS.has(realId)) return true;
    const text = [
      catalog?.realSearch?.get(String(realId)),
      catalog?.real?.get(String(realId)),
    ].map((value) => String(value || '')).join(' ');
    return realId === 10000001 || (/\bB1\b/i.test(text) && /\u767e\u5ea6|\u62e8\u6d4b/i.test(text));
  }

  function resolveDemandMatchingRealCustomerIds(realCustomerIds, virtualCustomerIds, catalog) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    if (normalizeBusinessIds(virtualCustomerIds).length) return realIds;
    if (realIds.length <= 1) return realIds;
    const primaryIds = realIds.filter((id) => !isStackableRealBusinessId(id, catalog));
    return primaryIds.length ? primaryIds : realIds;
  }

  function describeDemandMatchingBusinessScope(realCustomerIds, virtualCustomerIds, catalog) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const demandRealIds = resolveDemandMatchingRealCustomerIds(realIds, virtualCustomerIds, catalog);
    const stackableIds = realIds.filter((id) => !demandRealIds.includes(id));
    return {
      demandRealIds,
      stackableIds,
      demandRealText: formatBusinessNames(demandRealIds, catalog.real),
      stackableText: formatBusinessNames(stackableIds, catalog.real),
    };
  }

  function getVirtualBusinessRules(virtualCustomerIds, catalog) {
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    const associations = catalog?.virtualAssociations;
    const allowedRealIds = new Set();
    const requiredRealIds = new Set();
    const byVirtual = new Map();
    const unmappedVirtualIds = [];
    if (!associations || typeof associations.get !== 'function') {
      return { allowedRealIds, requiredRealIds, byVirtual, unmappedVirtualIds, hasMapping: false };
    }
    virtualIds.forEach((virtualId) => {
      const entries = (associations.get(String(virtualId)) || [])
        .map((item) => ({ customerId: Number(item?.customerId), mode: Number(item?.mode) }))
        .filter((item) => Number.isFinite(item.customerId));
      byVirtual.set(String(virtualId), entries);
      if (!entries.length) unmappedVirtualIds.push(virtualId);
      entries.forEach((item) => {
        allowedRealIds.add(item.customerId);
        if (item.mode === 1) requiredRealIds.add(item.customerId);
      });
    });
    return { allowedRealIds, requiredRealIds, byVirtual, unmappedVirtualIds, hasMapping: true };
  }

  function validateVirtualBusinessAssociations(realCustomerIds, virtualCustomerIds, catalog) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    if (!virtualIds.length) return true;
    const rules = getVirtualBusinessRules(virtualIds, catalog);
    if (!rules.hasMapping) return true;
    if (rules.unmappedVirtualIds.length) {
      throw new Error(`虚拟业务没有配置真实业务映射：${formatBusinessNames(rules.unmappedVirtualIds, catalog.virtual)}`);
    }
    const incompatible = realIds.filter((id) => !rules.allowedRealIds.has(id));
    if (incompatible.length) {
      throw new Error(`真实业务不属于已选虚拟业务：${formatBusinessNames(incompatible, catalog.real)}`);
    }
    const uncovered = virtualIds.filter((virtualId) => {
      const entries = rules.byVirtual.get(String(virtualId)) || [];
      return !entries.some((item) => realIds.includes(item.customerId));
    });
    if (uncovered.length) {
      throw new Error(`以下虚拟业务没有对应的真实业务：${formatBusinessNames(uncovered, catalog.virtual)}`);
    }
    return true;
  }

  function isVirtualBusinessCompatible(realCustomerIds, virtualCustomerId, catalog) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const associations = catalog?.virtualAssociations;
    if (!realIds.length) return true;
    if (!associations || typeof associations.get !== 'function') return true;
    const entries = (associations.get(String(virtualCustomerId)) || [])
      .map((item) => ({ customerId: Number(item?.customerId), mode: Number(item?.mode) }))
      .filter((item) => Number.isFinite(item.customerId));
    if (!entries.length) return false;
    return realIds.every((realId) => entries.some((item) => item.customerId === realId));
  }

  function isRealBusinessCompatible(virtualCustomerIds, realCustomerId, catalog) {
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    const realId = Number(realCustomerId);
    const associations = catalog?.virtualAssociations;
    if (!virtualIds.length) return true;
    if (!Number.isFinite(realId)) return false;
    if (!associations || typeof associations.get !== 'function') return true;
    return virtualIds.every((virtualId) => {
      const entries = (associations.get(String(virtualId)) || [])
        .map((item) => ({ customerId: Number(item?.customerId), mode: Number(item?.mode) }))
        .filter((item) => Number.isFinite(item.customerId));
      return entries.length ? entries.some((item) => item.customerId === realId) : true;
    });
  }

  function resolveIndependentBusinessTargetIds(selectedIds, lockedIds) {
    const selected = (selectedIds || []).map(normalizeNodeId).filter(Boolean);
    const ids = selected.length ? selected : (lockedIds || []).map(normalizeNodeId).filter(Boolean);
    return Array.from(new Set(ids));
  }

  function independentBusinessTargetIds() {
    const ids = resolveIndependentBusinessTargetIds(selectedNodeIds(), state.lockedTargetIds);
    return Array.from(new Set(ids.map(normalizeNodeId).filter(Boolean)));
  }

  function renderBusinessChoiceList(entries, kind, searchIndex = new Map(), selectedIds = new Set()) {
    if (!entries.length) return '<p class="nlnfm-business-empty">当前目录没有可选业务</p>';
    return entries
      .sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'))
      .map(([id, name]) => `
        <label data-business-choice data-business-search="${escapeHtml(searchIndex.get(String(id)) || `${name} ${id}`.toLowerCase())}">
          <input type="checkbox" data-business-kind="${escapeHtml(kind)}" value="${escapeHtml(id)}"${selectedIds.has(String(id)) ? ' checked' : ''}>
          <span>${escapeHtml(name)}</span><code>${escapeHtml(id)}</code>
        </label>`)
      .join('');
  }

  async function openManualBusinessTargetDialog(mode, preset = null) {
    const ids = independentBusinessTargetIds();
    if (!ids.length) return setNotice('请先锁定或勾选至少 1 个目标节点。');
    removeActionDialog();
    try {
      begin('正在读取信息编辑同源的真实/虚拟业务目录...');
      const catalog = await getBusinessCatalog();
      if (!catalog.real.size) throw new Error('真实业务目录为空，无法选择目标业务。');
      const isResubmit = mode === 'resubmit';
      const dialog = document.createElement('section');
      dialog.id = 'nlnfm-action-dialog';
      dialog.innerHTML = `
        <div class="nlnfm-dialog-head"><strong>${isResubmit ? '自选目标业务重新提交' : '自选目标业务切换'} <small>v${VERSION}</small></strong><button type="button" data-close-action>×</button></div>
        <p>将对 <b>${ids.length}</b> 个目标节点使用同一组目标业务；每个节点仍会根据自身网络属性独立匹配需求单。</p>
        <p class="nlnfm-dialog-hint">参考“信息编辑 → 推荐业务”的选择方式。真实业务至少选择 1 个；虚拟业务会根据当前真实业务联动收窄，二者都支持多选和叠加。</p>
        <div class="nlnfm-business-picker">
          <section>
            <header><strong>真实业务（必选）</strong><span data-business-count="real">已选 0</span></header>
            <input class="nlnfm-business-filter" type="search" data-business-filter="real" placeholder="搜索真实业务名称、ID 或代码">
            <div class="nlnfm-business-list" data-business-list="real">${renderBusinessChoiceList(Array.from(catalog.real.entries()), 'real', catalog.realSearch)}</div>
          </section>
          <section>
            <header><strong>虚拟业务（优先选择，可选）</strong><span data-business-count="virtual">已选 0</span></header>
            <input class="nlnfm-business-filter" type="search" data-business-filter="virtual" placeholder="搜索虚拟业务名称、ID 或代码">
            <div class="nlnfm-business-list" data-business-list="virtual">${renderBusinessChoiceList(Array.from(catalog.virtual.entries()), 'virtual', catalog.virtualSearch)}</div>
          </section>
        </div>
        <p class="nlnfm-dialog-hint nlnfm-virtual-rule-hint" data-virtual-rule-hint>未选择真实业务：右侧显示全部虚拟业务。</p>
        <p class="nlnfm-dialog-hint nlnfm-business-selection" data-business-selection>尚未选择真实业务。</p>
        <footer><button type="button" data-close-action>取消</button><button type="button" class="nlnfm-picker-confirm" data-manual-business-confirm disabled>进入逐节点需求单匹配</button></footer>`;
      const realList = dialog.querySelector('[data-business-list="real"]');
      const virtualList = dialog.querySelector('[data-business-list="virtual"]');
      const realFilter = dialog.querySelector('[data-business-filter="real"]');
      const virtualFilter = dialog.querySelector('[data-business-filter="virtual"]');
      const presetRealIds = new Set(normalizeBusinessIds(preset?.realCustomerIds || []).map(String));
      const presetVirtualIds = new Set(normalizeBusinessIds(preset?.virtualCustomerIds || []).map(String));

      const selectedRealIds = () => Array.from(dialog.querySelectorAll('[data-business-kind="real"]:checked'), (input) => Number(input.value)).filter(Number.isFinite);
      const selectedVirtualIds = () => Array.from(dialog.querySelectorAll('[data-business-kind="virtual"]:checked'), (input) => Number(input.value)).filter(Number.isFinite);

      const getVisibleRealEntries = () => {
        const virtualIds = selectedVirtualIds();
        const keyword = String(realFilter?.value || '').trim().toLowerCase();
        const visible = [];
        for (const [realId, realName] of catalog.real.entries()) {
          if (keyword && !(catalog.realSearch.get(String(realId)) || `${realName} ${realId}`).toLowerCase().includes(keyword)) continue;
          if (isRealBusinessCompatible(virtualIds, Number(realId), catalog)) {
            visible.push([realId, realName]);
          }
        }
        return { virtualIds, visible };
      };

      const getVisibleVirtualEntries = () => {
        const realIds = selectedRealIds();
        const keyword = String(virtualFilter?.value || '').trim().toLowerCase();
        const visible = [];
        for (const [virtualId, virtualName] of catalog.virtual.entries()) {
          if (keyword && !(catalog.virtualSearch.get(String(virtualId)) || `${virtualName} ${virtualId}`).toLowerCase().includes(keyword)) continue;
          if (isVirtualBusinessCompatible(realIds, Number(virtualId), catalog)) {
            visible.push([virtualId, virtualName]);
          }
        }
        return { realIds, visible };
      };

      const refreshRealList = () => {
        const { virtualIds, visible } = getVisibleRealEntries();
        const selectedIds = new Set(selectedRealIds().map(String));
        realList.innerHTML = visible.length
          ? renderBusinessChoiceList(visible, 'real', catalog.realSearch, selectedIds)
          : '<p class="nlnfm-business-empty">当前虚拟业务下暂无可匹配的真实业务，请调整虚拟业务选择</p>';
        return { virtualIds, visible };
      };

      const refreshVirtualList = () => {
        const { realIds, visible } = getVisibleVirtualEntries();
        const selectedIds = new Set(selectedVirtualIds().map(String));
        virtualList.innerHTML = visible.length
          ? renderBusinessChoiceList(visible, 'virtual', catalog.virtualSearch, selectedIds)
          : '<p class="nlnfm-business-empty">当前真实业务下暂无可匹配的虚拟业务，请调整真实业务选择</p>';
        const hint = dialog.querySelector('[data-virtual-rule-hint]');
        if (!realIds.length) {
          const virtualIds = selectedVirtualIds();
          hint.textContent = virtualIds.length
            ? `已按当前虚拟业务筛选左侧真实业务。`
            : '未选择真实业务：右侧显示全部虚拟业务。';
        } else {
          hint.textContent = visible.length
            ? `已按当前真实业务筛选出 ${visible.length} 个可选虚拟业务。`
            : '当前真实业务下暂无可匹配的虚拟业务，请调整真实业务选择。';
        }
        return visible;
      };

      const updateSelection = () => {
        const realIds = Array.from(dialog.querySelectorAll('[data-business-kind="real"]:checked'), (input) => input.value);
        const virtualIds = Array.from(dialog.querySelectorAll('[data-business-kind="virtual"]:checked'), (input) => input.value);
        dialog.querySelector('[data-business-count="real"]').textContent = `已选 ${realIds.length}`;
        dialog.querySelector('[data-business-count="virtual"]').textContent = `已选 ${virtualIds.length}`;
        dialog.querySelector('[data-manual-business-confirm]').disabled = !realIds.length;
        dialog.querySelector('[data-business-selection]').textContent = realIds.length
          ? `真实业务：${formatBusinessNames(realIds, catalog.real)}${virtualIds.length ? `；虚拟业务：${formatBusinessNames(virtualIds, catalog.virtual)}` : '；虚拟业务：不设置'}`
          : '尚未选择真实业务。';
      };

      const syncSelectionsToVisible = (changedKind = '') => {
        const realVisible = getVisibleRealEntries();
        const virtualVisible = getVisibleVirtualEntries();
        const realVisibleSet = new Set(realVisible.visible.map(([id]) => String(id)));
        const virtualVisibleSet = new Set(virtualVisible.visible.map(([id]) => String(id)));
        let cleared = false;
        dialog.querySelectorAll('[data-business-kind="real"]:checked').forEach((input) => {
          if (!realVisibleSet.has(String(input.value))) {
            input.checked = false;
            cleared = true;
          }
        });
        dialog.querySelectorAll('[data-business-kind="virtual"]:checked').forEach((input) => {
          if (!virtualVisibleSet.has(String(input.value))) {
            input.checked = false;
            cleared = true;
          }
        });
        refreshRealList();
        refreshVirtualList();
        updateSelection();
        if (cleared) {
          const realIds = selectedRealIds();
          const virtualIds = selectedVirtualIds();
          const source = changedKind === 'virtual' ? '虚拟业务变化' : '真实业务变化';
          dialog.querySelector('[data-business-selection]').textContent = realIds.length
            ? `真实业务：${formatBusinessNames(realIds, catalog.real)}${virtualIds.length ? `；虚拟业务：${formatBusinessNames(virtualIds, catalog.virtual)}` : ''}；部分已选项因${source}已自动清理`
            : `尚未选择真实业务；部分已选项因${source}已自动清理。`;
        }
      };

      const refreshAndSync = (changedKind = '') => {
        syncSelectionsToVisible(changedKind);
      };

      dialog.addEventListener('input', (event) => {
        const filter = event.target.closest?.('[data-business-filter]');
        if (!filter) return;
        refreshAndSync(filter.dataset.businessFilter);
      });
      dialog.addEventListener('change', (event) => {
        if (!event.target.matches?.('[data-business-kind]')) return;
        refreshAndSync(event.target.dataset.businessKind);
      });
      dialog.addEventListener('click', async (event) => {
        if (event.target.closest('[data-close-action]')) return removeActionDialog();
        const confirm = event.target.closest('[data-manual-business-confirm]');
        if (!confirm) return;
        try {
          const target = buildManualBusinessTarget(
            Array.from(dialog.querySelectorAll('[data-business-kind="real"]:checked'), (input) => input.value),
            Array.from(dialog.querySelectorAll('[data-business-kind="virtual"]:checked'), (input) => input.value),
            catalog
          );
          removeActionDialog();
          finish(`已选择完整目标业务，准备为 ${ids.length} 个目标节点分别查询需求单。`);
          await showBusinessDemandDialog(ids, target, { mode, targetSource: 'manual' });
        } catch (error) {
          dialog.querySelector('[data-business-selection]').textContent = message(error);
        }
      });
      document.body.appendChild(dialog);
      refreshRealList();
      refreshVirtualList();
      if (presetRealIds.size) {
        dialog.querySelectorAll('[data-business-kind="real"]').forEach((input) => { if (presetRealIds.has(String(input.value))) input.checked = true; });
      }
      if (presetVirtualIds.size) {
        dialog.querySelectorAll('[data-business-kind="virtual"]').forEach((input) => { if (presetVirtualIds.has(String(input.value))) input.checked = true; });
      }
      refreshRealList();
      refreshVirtualList();
      updateSelection();
      finish(`业务目录已加载，请选择 ${ids.length} 个节点的目标业务。`);
    } catch (error) {
      finish(`无法打开目标业务选择器：${message(error)}`);
    }
  }

  async function openBusinessSwitchFromMasterDialog() {
    if (!state.template?.nodeId) return setNotice('请先设置主节点。');
    const followerIds = targetIds();
    if (!followerIds.length) return setNotice('请先锁定或勾选至少 1 个从节点。');
    try {
      begin('正在读取主节点当前完整业务目标...');
      const masterDetail = await getNode(state.template.nodeId);
      const catalog = await getBusinessCatalog();
      const target = resolveBusinessTarget(masterDetail, catalog);
      finish(`已读取主节点完整业务，准备为 ${followerIds.length} 个从节点分别查询需求单。`);
      await showBusinessDemandDialog(followerIds, target, { mode: 'switch', targetSource: 'master-current' });
    } catch (error) {
      finish(`无法创建业务切换任务：${message(error)}`);
    }
  }

  async function openBusinessResubmitDialog() {
    if (!state.template?.nodeId) return setNotice('请先设置主节点。');
    const followerIds = targetIds();
    if (!followerIds.length) return setNotice('请先锁定或勾选至少 1 个从节点。');
    try {
      begin('正在读取主节点的目标业务...');
      const masterDetail = await getNode(state.template.nodeId);
      if (!BUSINESS_RESUBMIT_STAGES.has(masterDetail.stage)) {
        throw new Error(`主节点阶段 ${masterDetail.stage || '--'} 不允许重新提交，仅支持验收不通过（uncensored）。`);
      }
      const catalog = await getBusinessCatalog();
      const target = resolveBusinessTarget(masterDetail, catalog);
      const ids = Array.from(new Set([state.template.nodeId, ...followerIds]));
      finish(`已读取主节点目标业务，准备为主节点和 ${followerIds.length} 个从节点分别查询需求单。`);
      await showBusinessDemandDialog(ids, {
        ...target,
        uncensoredRollBack: true,
      }, {
        mode: 'resubmit',
        masterNodeId: state.template.nodeId,
      });
    } catch (error) {
      finish(`无法创建目标业务重提任务：${message(error)}`);
    }
  }

  async function openBusinessSwitchDialog(capturedTarget = null) {
    const ids = targetIds();
    if (!ids.length) return setNotice('请先锁定从节点或勾选操作目标。');
    const realCustomerIds = normalizeBusinessIds(capturedTarget?.realCustomerIds || [capturedTarget?.realCustomerId]);
    if (!realCustomerIds.length) {
      return setNotice('请先点击“录制业务切换”，在主节点完成真实业务切换后，再回到此面板填写从节点需求单。');
    }
    await showBusinessDemandDialog(ids, {
      ...capturedTarget,
      realCustomerIds,
      virtualCustomerIds: normalizeBusinessIds(capturedTarget?.virtualCustomerIds || [capturedTarget?.virtualCustomerId]),
    }, { mode: 'switch', targetSource: 'recorded-operation' });
  }

  async function showBusinessDemandDialog(ids, capturedTarget, options = {}) {
    removeActionDialog();
    const catalog = await getBusinessCatalog();
    const dialog = document.createElement('section');
    dialog.id = 'nlnfm-action-dialog';
    const isResubmit = options.mode === 'resubmit';
    const isManualTarget = options.targetSource === 'manual' || options.targetSource === 'scene-language';
    const masterNodeId = normalizeNodeId(options.masterNodeId);
    const actionTitle = isManualTarget
      ? (isResubmit ? '自选目标业务重提：匹配需求单' : '自选目标业务切换：匹配需求单')
      : (isResubmit ? '重新提交主从目标业务' : '业务切换：填写从节点需求单');
    const targetLabel = isManualTarget ? `${ids.length} 个目标节点` : (isResubmit ? `${ids.length} 个主从节点` : `${ids.length} 个从节点`);
    const targetSourceText = options.targetSource === 'scene-language'
      ? '已从场景语言识别'
      : (isManualTarget
        ? '已在脚本中手动选择'
        : (isResubmit || options.targetSource === 'master-current'
          ? '已从主节点当前配置读取'
          : '已从主节点成功操作中读取'));
    const demandScope = describeDemandMatchingBusinessScope(capturedTarget.realCustomerIds, capturedTarget.virtualCustomerIds, catalog);
    const realText = formatBusinessNames(capturedTarget.realCustomerIds, catalog.real);
    const virtualText = capturedTarget.virtualCustomerIds.length ? `，虚拟业务 ${formatBusinessNames(capturedTarget.virtualCustomerIds, catalog.virtual)}` : '，不设置虚拟业务';
    const defaultHint = capturedTarget.defaultRealMappings?.length ? `<p class="nlnfm-dialog-hint nlnfm-demand-warning">已按默认规则补齐真实业务：${escapeHtml(formatDefaultRealMappings(capturedTarget.defaultRealMappings, catalog))}。</p>` : '';
    dialog.innerHTML = `
      <div class="nlnfm-dialog-head"><strong>${escapeHtml(actionTitle)} <small>v${VERSION}</small></strong><button type="button" data-close-action>×</button></div>
      <p>${escapeHtml(targetSourceText)}目标：真实业务 <b>${escapeHtml(realText)}</b>${escapeHtml(virtualText)}。</p>
      ${defaultHint}
      ${demandScope.stackableIds.length ? `<p class="nlnfm-dialog-hint nlnfm-demand-warning">需求单按主体业务 <b>${escapeHtml(demandScope.demandRealText)}</b> 查询；叠加业务 <b>${escapeHtml(demandScope.stackableText)}</b> 不单独要求需求单，但提交/重提时仍会一并写入目标业务。</p>` : ''}
      ${capturedTarget.virtualTargetSource === 'vendor-expectation' ? '<p class="nlnfm-dialog-hint nlnfm-demand-warning">主节点目标虚拟业务为空，本次虚拟业务已从“矿主期望业务”中识别。请在预检中确认名称无误后再执行。</p>' : ''}
      <details class="nlnfm-demand-hint-detail"><summary>候选需求单说明</summary><p class="nlnfm-dialog-hint">按 niulink_tool 的严格口径查询候选需求单；满足唯一候选或明显领先才自动选择，其余必须人工选择。若所选需求单要求调整上报地区/运营商，执行时会先通过信息编辑同步节点的 <code>bizProvince / bizCity / bizIsp</code>，回读确认后再继续。</p>${isResubmit ? `<p class="nlnfm-dialog-hint">仅验收不通过节点可执行“信息更新 + 重新提交审核”两步。</p>` : ''}${!isResubmit ? `<p class="nlnfm-dialog-hint">仅 censored/inService ${isManualTarget ? '目标节点' : '从节点'}可执行 switchcustomer。</p>` : ''}</details>
      <div class="nlnfm-demand-toolbar"><button type="button" data-demand-query>查询 ${escapeHtml(targetLabel)} 的候选需求单</button><button type="button" data-demand-smart-match disabled>智能一键匹配</button><span data-demand-status>尚未查询</span></div>
      <label class="nlnfm-demand-reuse"><input type="checkbox" data-demand-reuse> 允许同一需求单批量复用（默认关闭）</label>
      <p class="nlnfm-dialog-hint nlnfm-demand-reuse-hint">启用后仅在接口返回 <code>claimable=true</code>，或平台标记单节点但容量校验通过时受控放行；实际写入改为逐节点串行，并在每次写入前重新查询需求单。</p>
      <div class="nlnfm-demand-results" data-demand-results><p>点击“查询候选需求单”后，在这里选择每个节点对应的需求单。</p></div>
      <footer><button type="button" data-close-action>取消</button><button type="button" class="nlnfm-picker-confirm" data-business-precheck disabled>${isResubmit ? '预检目标业务重提' : '预检业务切换'}</button></footer>`;
    let demandMap = {};
    let demandResults = [];
    let allowDemandReuse = false;
    dialog.addEventListener('click', async (event) => {
      if (event.target.closest('[data-close-action]')) return removeActionDialog();
      const queryButton = event.target.closest('[data-demand-query]');
      if (queryButton) {
        queryButton.disabled = true;
        queryButton.textContent = '查询中...';
        const status = dialog.querySelector('[data-demand-status]');
        const resultsBox = dialog.querySelector('[data-demand-results]');
        try {
          const results = await queryDemandCandidates(ids, demandScope.demandRealIds, capturedTarget.virtualCustomerIds, catalog);
          demandResults = results;
          demandMap = buildInitialDemandMap(results, masterNodeId, allowDemandReuse);
          renderDemandCandidates(resultsBox, results, demandMap, masterNodeId);
          const smartMatchButton = dialog.querySelector('[data-demand-smart-match]');
          if (smartMatchButton) smartMatchButton.disabled = !results.some((item) => item.candidates.length);
          updateDemandPrecheckState(dialog, demandMap, ids, demandResults, allowDemandReuse);
          const matched = results.filter((item) => item.candidates.length).length;
          status.textContent = `已查到 ${matched}/${ids.length} 个节点有候选需求单`;
        } catch (error) {
          resultsBox.innerHTML = `<p class="nlnfm-demand-error">查询失败：${escapeHtml(message(error))}</p>`;
          status.textContent = '查询失败';
        } finally {
          queryButton.disabled = false;
          queryButton.textContent = '重新查询候选需求单';
        }
        return;
      }
      const smartMatchButton = event.target.closest('[data-demand-smart-match]');
      if (smartMatchButton) {
        const matching = buildSmartDemandMap(demandResults, ids, masterNodeId, allowDemandReuse);
        demandMap = matching.demandMap;
        renderDemandCandidates(dialog.querySelector('[data-demand-results]'), demandResults, demandMap, masterNodeId);
        updateDemandPrecheckState(dialog, demandMap, ids, demandResults, allowDemandReuse);
        const status = dialog.querySelector('[data-demand-status]');
        if (status) {
          status.textContent = matching.unmatchedNodeIds.length
            ? `智能匹配完成：已分配 ${matching.matchedCount}/${ids.length} 个节点；${matching.unmatchedNodeIds.length} 个节点暂无可安全分配的需求单`
            : `智能匹配完成：${matching.matchedCount}/${ids.length} 个节点已优先分配独立需求单`;
        }
        return;
      }
      const select = event.target.closest('[data-demand-node]');
      if (select) {
        if (select.value) demandMap[select.dataset.demandNode] = select.value;
        else delete demandMap[select.dataset.demandNode];
        updateDemandPrecheckState(dialog, demandMap, ids, demandResults, allowDemandReuse);
        return;
      }
      if (!event.target.closest('[data-business-precheck]')) return;
      const button = event.target.closest('[data-business-precheck]');
      button.disabled = true;
      button.textContent = '预检中...';
      try {
        const demandEvidenceMap = buildDemandEvidenceMap(demandResults, demandMap);
        const selectedDemandMap = buildSelectedDemandCandidateMap(demandResults, demandMap);
        const reportingSyncPlanMap = buildReportingSyncPlanMap(demandResults, demandMap);
        const reportingOverrideMap = Object.fromEntries(Object.entries(reportingSyncPlanMap).map(([nodeId, plan]) => [nodeId, plan?.reportingOverride || null]));
        const preview = isResubmit
          ? await buildBusinessResubmitPreview(ids, capturedTarget.realCustomerIds, capturedTarget.virtualCustomerIds, demandMap, masterNodeId, demandEvidenceMap, reportingOverrideMap, reportingSyncPlanMap, selectedDemandMap, catalog)
          : await buildBusinessSwitchPreview(ids, capturedTarget.realCustomerIds, capturedTarget.virtualCustomerIds, demandMap, demandEvidenceMap, reportingOverrideMap, reportingSyncPlanMap, selectedDemandMap, catalog);
        writeAudit('business-dry-run', {
          mode: isResubmit ? 'resubmit' : 'switch',
          realCustomerIds: normalizeBusinessIds(capturedTarget.realCustomerIds),
          virtualCustomerIds: normalizeBusinessIds(capturedTarget.virtualCustomerIds),
          items: preview.items.map((item) => ({
            nodeId: item.nodeId,
            ok: item.ok,
            demandId: demandMap[item.nodeId] || null,
            endpoint: isResubmit ? 'dataedit + doaction(reSubmitAfterUncensored)' : 'switchcustomer',
            evidence: item.evidence || null,
            reportingSyncPlan: reportingSyncPlanMap[item.nodeId] || null,
            reportingOverride: reportingOverrideMap[item.nodeId] || null,
            reason: item.reason || null,
          })),
        });
        showBatchActionPreview(isResubmit ? '主从目标业务重提预检' : '业务切换预检', preview, async () => {
      assertUniqueDemandAssignments(preview.ready, demandMap, demandResults, { allowDemandReuse });
      const requiresSerialWrites = allowDemandReuse && hasDuplicateDemandAssignments(preview.ready, demandMap);
      const results = await mapConcurrent(preview.ready, requiresSerialWrites ? 1 : (isResubmit ? 2 : WRITE_CONCURRENCY), async (item) => {
        try {
          let dataeditVerified = null;
          let verified = null;
          const executionTarget = {
            ...capturedTarget,
            reportingSyncPlan: reportingSyncPlanMap[item.nodeId] || null,
            reportingOverride: reportingOverrideMap[item.nodeId],
            demandReuse: requiresSerialWrites ? { enabled: true, requiredBandwidth: getNodeConstructionBandwidth(item.detail) } : null,
          };
          if (isResubmit) {
            dataeditVerified = await executeBusinessResubmit(item, executionTarget, demandMap[item.nodeId]);
            verified = await verifyResubmitSubmitted(item.nodeId, executionTarget, demandMap[item.nodeId]);
          } else {
            await executeBusinessSwitch(item, executionTarget, demandMap[item.nodeId]);
            verified = await verifySubmittedBusinessTarget(
              item.nodeId,
              capturedTarget.realCustomerIds,
              capturedTarget.virtualCustomerIds,
              demandMap[item.nodeId],
              BUSINESS_SWITCH_POST_STAGES,
              '提交后',
              reportingOverrideMap[item.nodeId]
            );
          }
          return buildBusinessExecutionResult(item.nodeId, capturedTarget, demandMap[item.nodeId], isResubmit, true, verified, null, dataeditVerified);
        } catch (error) {
          return buildBusinessExecutionResult(item.nodeId, capturedTarget, demandMap[item.nodeId], isResubmit, false, null, error);
        }
      });
      finishBatchAction(
        isResubmit ? '主从目标业务重提' : '业务切换',
        results,
        buildBusinessBatchResultSuffix(results, isResubmit)
      );
    });
      } catch (error) {
        setNotice(`${isResubmit ? '目标业务重提' : '业务切换'}预检失败：${message(error)}`);
        button.disabled = false;
        button.textContent = isResubmit ? '预检目标业务重提' : '预检业务切换';
      }
    });
    dialog.addEventListener('change', (event) => {
      const select = event.target.closest?.('[data-demand-node]');
      if (!select) return;
      if (select.value) demandMap[select.dataset.demandNode] = select.value;
      else delete demandMap[select.dataset.demandNode];
      updateDemandPrecheckState(dialog, demandMap, ids, demandResults, allowDemandReuse);
    });
    dialog.addEventListener('change', (event) => {
      const reuseInput = event.target.closest?.('[data-demand-reuse]');
      if (!reuseInput) return;
      allowDemandReuse = reuseInput.checked === true;
      if (demandResults.length) {
        demandMap = buildInitialDemandMap(demandResults, masterNodeId, allowDemandReuse);
        renderDemandCandidates(dialog.querySelector('[data-demand-results]'), demandResults, demandMap, masterNodeId);
      }
      updateDemandPrecheckState(dialog, demandMap, ids, demandResults, allowDemandReuse);
    });
    document.body.appendChild(dialog);
    if (options.autoQuery) window.setTimeout(() => dialog.querySelector('[data-demand-query]')?.click(), 0);
  }

  function updateDemandPrecheckState(dialog, demandMap, ids, demandResults = [], allowDemandReuse = false) {
    const selectedDemandIds = ids.map((nodeId) => demandMap[nodeId]).filter(Boolean);
    const hasDuplicateDemandIds = selectedDemandIds.length !== new Set(selectedDemandIds).size;
    const reuseCheck = validateDemandReuse(ids, demandMap, demandResults);
    const ready = ids.every((nodeId) => Boolean(demandMap[nodeId])) && (!hasDuplicateDemandIds || (allowDemandReuse && reuseCheck.ok));
    const button = dialog.querySelector('[data-business-precheck]');
    if (button) button.disabled = !ready;
    const status = dialog.querySelector('[data-demand-status]');
    if (status && hasDuplicateDemandIds && !allowDemandReuse) {
      status.textContent = '存在重复 demandId；如需复用请勾选“允许同一需求单批量复用”并通过容量校验';
    } else if (status && hasDuplicateDemandIds && !reuseCheck.ok) {
      status.textContent = `复用校验未通过：${reuseCheck.reason}${describeReusableDemandAvailability(ids, demandResults)}`;
    } else if (status && hasDuplicateDemandIds) {
      status.textContent = `复用校验通过：${reuseCheck.summary}；执行时将逐节点串行复核`;
    } else if (status) {
      status.textContent = `已选择 ${selectedDemandIds.length}/${ids.length} 个节点，需求单未重复`;
    }
  }

  function assertUniqueDemandAssignments(items, demandMap, demandResults = [], options = {}) {
    const assignments = (items || []).map((item) => ({
      nodeId: normalizeNodeId(item?.nodeId),
      demandId: String(demandMap?.[item?.nodeId] || '').trim(),
    }));
    const missing = assignments.find((item) => !item.nodeId || !item.demandId);
    if (missing) throw new Error(`安全拦截：节点 ${missing.nodeId || '--'} 缺少独立 demandId。`);
    const demandIds = assignments.map((item) => item.demandId);
    if (new Set(demandIds).size !== demandIds.length && !options.allowDemandReuse) {
      throw new Error('安全拦截：批量任务存在重复 demandId，禁止跨节点复用需求单。');
    }
    if (new Set(demandIds).size !== demandIds.length) {
      const reuseCheck = validateDemandReuse(assignments.map((item) => item.nodeId), demandMap, demandResults);
      if (!reuseCheck.ok) throw new Error(`安全拦截：重复需求单容量校验失败：${reuseCheck.reason}`);
    }
    return assignments;
  }

  function buildMatchingContext(detail, realCustomerIds = [], virtualCustomerIds = [], options = {}) {
    const nominal = detail?.nominalInfo || {};
    return {
      nodeId: normalizeNodeId(detail?.nodeID || detail?.nodeId),
      nodeName: detail?.nodeName || detail?.name || '',
      stage: detail?.stage || '',
      detail,
      demandId: String(detail?.demandId || ''),
      realCustomerIds: normalizeBusinessIds(realCustomerIds),
      virtualCustomerIds: normalizeBusinessIds(virtualCustomerIds),
      currentReporting: {
        province: String(nominal.bizProvince || nominal.province || ''),
        city: String(nominal.bizCity || nominal.city || ''),
        isp: String(nominal.bizIsp || nominal.isp || ''),
      },
      physical: {
        province: String(nominal.province || ''),
        city: String(nominal.city || ''),
        isp: String(nominal.isp || ''),
      },
      resource: {
        webPort: String(nominal.webPort || ''),
        resourceType: String(nominal.resourceType || ''),
        ipv6: Boolean(nominal.isIPv6Schedule),
        constructionBandwidth: getNodeConstructionBandwidth(detail),
      },
      scenario: {
        isTencentDemand: Boolean(options.isTencentDemand),
        isResubmit: Boolean(options.isResubmit),
        isBusinessSwitch: options.isResubmit !== true,
      },
    };
  }

  function buildReportingSyncPlan(context, candidate) {
    const override = completeReportingOverride(candidate?.reportingOverride, context?.detail?.nominalInfo || {});
    if (!context || !override) return null;
    const before = {
      province: context.currentReporting?.province || '',
      city: context.currentReporting?.city || '',
      isp: context.currentReporting?.isp || '',
    };
    const target = {
      province: override.bizProvince || before.province,
      city: override.bizCity || before.city,
      isp: override.bizIsp || before.isp,
    };
    const required = target.province !== before.province || target.city !== before.city || target.isp !== before.isp;
    return {
      required,
      before,
      target,
      reason: override.reason || '',
      sourceDemandId: candidate.id || '',
      syncStatus: required ? 'pending' : 'noop',
      reportingOverride: override,
    };
  }

  function decideDemandSelection(item, options = {}) {
    const usedDemandIds = options.usedDemandIds || new Set();
    const allowDemandReuse = options.allowDemandReuse === true;
    const currentDemandId = String(item?.detail?.demandId || '');
    const candidates = item?.candidates || [];
    const context = item?.matchingContext || buildMatchingContext(item?.detail);
    const currentCandidate = currentDemandId ? candidates.find((candidate) => candidate.id === currentDemandId) : null;
    let selectedCandidate = null;
    let autoSelected = false;
    let reason = '';

    if (options.masterNodeId && item?.nodeId === options.masterNodeId && currentCandidate) {
      selectedCandidate = currentCandidate;
      autoSelected = true;
      reason = '保留主节点当前 demandId';
    } else if (currentCandidate && isDemandCandidateEligibleForAutomatic(currentCandidate, item.detail) && (allowDemandReuse || !usedDemandIds.has(currentDemandId))) {
      selectedCandidate = currentCandidate;
      autoSelected = true;
      reason = '当前 demandId 仍然合法，优先保留';
    } else {
      selectedCandidate = selectAutomaticDemandCandidate(candidates, allowDemandReuse ? new Set() : usedDemandIds);
      autoSelected = Boolean(selectedCandidate);
      reason = selectedCandidate
        ? (candidates.length === 1 ? '唯一合法候选，自动选择' : '最高分候选显著领先，自动选择')
        : (candidates.length ? '候选存在歧义，需要人工确认' : '没有合法候选');
    }

    const reportingSyncPlan = selectedCandidate ? buildReportingSyncPlan(context, selectedCandidate) : null;
    return {
      nodeId: item?.nodeId,
      candidates,
      selectedDemandId: selectedCandidate?.id || '',
      selectedCandidate: selectedCandidate || null,
      autoSelected,
      needsManualConfirm: !selectedCandidate || !autoSelected,
      reportingSyncPlan,
      diagnostics: {
        reason,
        candidateCount: candidates.length,
      },
    };
  }

  function buildInitialDemandSelection(results, masterNodeId = null, allowDemandReuse = false) {
    const usedDemandIds = new Set();
    const demandMap = {};
    (results || []).forEach((item) => {
      const decision = decideDemandSelection(item, { masterNodeId, allowDemandReuse, usedDemandIds });
      item.matchingDecision = decision;
      item.reportingSyncPlan = decision.reportingSyncPlan;
      if (!decision.autoSelected || !decision.selectedDemandId) return;
      demandMap[item.nodeId] = decision.selectedDemandId;
      if (!allowDemandReuse) usedDemandIds.add(decision.selectedDemandId);
    });
    return demandMap;
  }

  function buildInitialDemandMap(results, masterNodeId = null, allowDemandReuse = false) {
    return buildInitialDemandSelection(results, masterNodeId, allowDemandReuse);
  }

  function buildSmartDemandMap(results, ids, masterNodeId = null, allowDemandReuse = false) {
    const resultByNodeId = new Map((results || []).map((item) => [item.nodeId, item]));
    const selected = {};
    const usedDemandIds = new Set();
    const targetIds = Array.from(new Set((ids || []).map(normalizeNodeId).filter(Boolean)));

    // Match constrained nodes first so broad candidate lists do not consume their only valid demand.
    const ordered = targetIds
      .map((nodeId) => resultByNodeId.get(nodeId))
      .filter(Boolean)
      .sort((left, right) => {
        const candidateDifference = (left.candidates || []).filter((candidate) => isDemandCandidateEligibleForAutomatic(candidate, left.detail)).length -
          (right.candidates || []).filter((candidate) => isDemandCandidateEligibleForAutomatic(candidate, right.detail)).length;
        return candidateDifference || String(left.nodeId).localeCompare(String(right.nodeId));
      });

    ordered.forEach((item) => {
      const decision = item.matchingDecision || decideDemandSelection(item, { masterNodeId, allowDemandReuse, usedDemandIds });
      item.matchingDecision = decision;
      item.reportingSyncPlan = decision.reportingSyncPlan;
      const currentDemandId = String(item.detail?.demandId || '');
      const eligibleCandidates = (item.candidates || []).filter((candidate) => isDemandCandidateEligibleForAutomatic(candidate, item.detail));
      const currentCandidate = eligibleCandidates.find((candidate) => candidate.id === currentDemandId);
      const candidate =
        (decision.autoSelected && decision.selectedCandidate && (allowDemandReuse || !usedDemandIds.has(decision.selectedCandidate.id)) && decision.selectedCandidate) ||
        (item.nodeId === masterNodeId && currentCandidate && !usedDemandIds.has(currentDemandId) && currentCandidate) ||
        eligibleCandidates.find((entry) => !usedDemandIds.has(entry.id));
      if (!candidate) return;
      selected[item.nodeId] = candidate.id;
      usedDemandIds.add(candidate.id);
    });

    if (allowDemandReuse) {
      ordered.forEach((item) => {
        if (selected[item.nodeId]) return;
        const reusable = item.candidates?.find((candidate) => isDemandCandidateEligibleForAutomatic(candidate, item.detail));
        if (!reusable) return;
        selected[item.nodeId] = reusable.id;
        if (!validateDemandReuse(targetIds, selected, results).ok) delete selected[item.nodeId];
      });
    }

    const unmatchedNodeIds = targetIds.filter((nodeId) => !selected[nodeId]);
    return {
      demandMap: selected,
      matchedCount: targetIds.length - unmatchedNodeIds.length,
      uniqueCount: new Set(Object.values(selected)).size,
      unmatchedNodeIds,
    };
  }

  function hasDuplicateDemandAssignments(items, demandMap) {
    const demandIds = (items || []).map((item) => String(demandMap?.[item?.nodeId] || '')).filter(Boolean);
    return new Set(demandIds).size !== demandIds.length;
  }

  function getNodeConstructionBandwidth(detail) {
    const nominal = detail?.nominalInfo || {};
    const deployUsbw = Number(nominal.deployUsbw);
    if (Number.isFinite(deployUsbw) && deployUsbw > 0) return deployUsbw;
    const usbw = Number(nominal.usbw);
    const bwNum = Number(nominal.bwNum);
    if (Number.isFinite(usbw) && usbw > 0 && Number.isFinite(bwNum) && bwNum > 0) return usbw * bwNum;
    const bandwidth = Number(nominal.bandwidth);
    return Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null;
  }

  function validateDemandReuse(ids, demandMap, demandResults) {
    const resultByNodeId = new Map((demandResults || []).map((item) => [item.nodeId, item]));
    const groups = new Map();
    (ids || []).forEach((nodeId) => {
      const demandId = String(demandMap?.[nodeId] || '').trim();
      if (!demandId) return;
      const group = groups.get(demandId) || [];
      group.push(nodeId);
      groups.set(demandId, group);
    });
    const reusedGroups = Array.from(groups.entries()).filter(([, nodeIds]) => nodeIds.length > 1);
    if (!reusedGroups.length) return { ok: true, reason: '', summary: '无复用' };
    const summaries = [];
    for (const [demandId, nodeIds] of reusedGroups) {
      const records = nodeIds.map((nodeId) => resultByNodeId.get(nodeId));
      const candidates = records.map((record) => record?.candidates?.find((candidate) => candidate.id === demandId));
      if (candidates.some((candidate) => !candidate)) {
        return { ok: false, reason: `需求单 ${demandId} 不在所有节点的候选结果中` };
      }
      const required = records.map((record) => getNodeConstructionBandwidth(record?.detail));
      if (required.some((value) => !Number.isFinite(value) || value <= 0)) {
        return { ok: false, reason: `无法读取需求单 ${demandId} 对应节点的建设带宽` };
      }
      const totalRequired = required.reduce((sum, value) => sum + value, 0);
      const unlimited = candidates.some((candidate) => candidate.bandwidthUnlimited === true);
      const remaining = unlimited ? Infinity : Math.min(...candidates.map((candidate) => demandBandwidthValue(candidate)));
      if (!unlimited && remaining < totalRequired) {
        return { ok: false, reason: `需求单 ${demandId} 剩余 ${formatDemandBandwidth(remaining)}，小于合计建设带宽 ${formatDemandBandwidth(totalRequired)}` };
      }
      const hasPlatformSingleRisk = candidates.some((candidate) => candidate.claimable !== true);
      summaries.push(
        `需求单 ${demandId}：剩余 ${formatDemandBandwidth(remaining)}，合计建设 ${formatDemandBandwidth(totalRequired)}（${nodeIds.length} 台）` +
        (hasPlatformSingleRisk ? '；平台标记单节点，本次按受控复用放行' : '')
      );
    }
    return { ok: true, reason: '', summary: summaries.join('；') };
  }
  function describeReusableDemandAvailability(ids, demandResults) {
    const records = (ids || []).map((nodeId) => (demandResults || []).find((item) => item.nodeId === nodeId)).filter(Boolean);
    if (records.length !== (ids || []).length) return '';
    const reusableSets = records.map((record) => new Set((record.candidates || []).filter((candidate) => candidate.claimable === true).map((candidate) => candidate.id)));
    const reusableIds = reusableSets.slice(1).reduce(
      (shared, idsForNode) => new Set([...shared].filter((id) => idsForNode.has(id))),
      reusableSets[0] || new Set()
    );
    return `；当前所有节点共同候选中可复用需求单 ${reusableIds.size} 个`;
  }

  function selectAutomaticDemandCandidate(candidates, usedDemandIds = new Set()) {
    const available = (candidates || []).filter((candidate) => !usedDemandIds.has(candidate.id));
    if (available.length === 1) return available[0];
    if (available.length < 2) return null;
    const [first, second] = available;
    return first.score >= AUTO_DEMAND_MIN_SCORE && first.score - second.score >= AUTO_DEMAND_MIN_GAP ? first : null;
  }

  function isDemandCandidateEligibleForAutomatic(candidate, detail) {
    return Number(candidate?.score) >= AUTO_DEMAND_MIN_SCORE && hasDemandCapacityCandidate([candidate], detail);
  }

  function parseDemandBandwidth(item = {}) {
    const raw = item.unclaimedBw;
    const numeric = Number(raw);
    const total = Number(item.demandBw);
    const text = [
      raw,
      item.unclaimedBwText,
      item.demandBwText,
      item.bandwidthText,
      item.lackBandwidthText,
      item.bandwidthDesc,
      item.remark,
    ].map((value) => String(value || '')).join(' ');
    const unlimited = /\u4e0d\u9650|\u65e0\u9650|unlimited|infinite/i.test(text) ||
      (Number.isFinite(total) && total === 0 && (raw === undefined || raw === null || raw === '' || numeric === 0));
    return {
      rawUnclaimedBw: raw,
      unclaimedBw: Number.isFinite(numeric) ? numeric : 0,
      bandwidthUnlimited: unlimited,
    };
  }

  function demandBandwidthValue(candidate = {}) {
    if (candidate.bandwidthUnlimited === true) return Infinity;
    const value = Number(candidate.unclaimedBw);
    return Number.isFinite(value) ? value : 0;
  }

  async function queryDemandCandidates(ids, realCustomerIds, virtualCustomerIds, catalog) {
    return mapConcurrent(ids, 3, async (nodeId) => {
      try {
        const detail = await getNode(nodeId);
        const result = await fetchDemandCandidatesForTargets(detail, realCustomerIds, virtualCustomerIds, catalog);
        const adaptiveText = `${result?.criteria?.adaptivePolicy || ''} ${result?.criteria?.matchMode || ''}`.toLowerCase();
        const matchingContext = buildMatchingContext(detail, realCustomerIds, virtualCustomerIds, {
          isTencentDemand: adaptiveText.includes('腾讯') || adaptiveText.includes('定向j') || adaptiveText.includes('direction j'),
        });
        return { nodeId, detail, matchingContext, candidates: result.candidates, criteria: result.criteria, diagnostics: result.diagnostics, error: '' };
      } catch (error) {
        return { nodeId, detail: null, candidates: [], error: message(error) };
      }
    });
  }
  async function fetchDemandCandidatesForTargets(detail, realCustomerIds, virtualCustomerIds, catalog) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    const adaptivePolicy = resolveTencentDemandPolicy(detail, realIds, virtualIds, catalog);
    const pairs = virtualIds.length
      ? virtualIds.flatMap((virtualCustomerId) => realIds.map((realCustomerId) => ({ realCustomerId, virtualCustomerId })))
      : realIds.map((realCustomerId) => ({ realCustomerId, virtualCustomerId: null }));
    if (!pairs.length) throw new Error('目标真实业务为空，无法查询需求单。');

    const results = await mapConcurrent(pairs, 3, ({ realCustomerId, virtualCustomerId }) =>
      fetchDemandCandidates(detail, realCustomerId, virtualCustomerId, catalog, adaptivePolicy)
    );
    const criteria = {
      ...results[0].criteria,
      customerId: virtualIds.length ? virtualIds.join('+') : realIds.join('+'),
      realCustomerId: virtualIds.length ? realIds.join('+') : '',
      matchMode: results.map((result) => result.criteria.matchMode).filter((value, index, values) => values.indexOf(value) === index).join(' / '),
      adaptivePolicy: adaptivePolicy.label,
    };
    const candidates = Array.from(new Map(results.flatMap((result) => result.candidates).map((item) => [item.id, item])).values())
      .filter((candidate) => demandCoversAllTargets(candidate, realIds, virtualIds))
      .map((candidate) => ({ ...candidate, ...scoreDemandCandidate(candidate, criteria) }))
      .sort((left, right) => right.score - left.score || demandBandwidthValue(right) - demandBandwidthValue(left));
    return {
      candidates,
      criteria,
      diagnostics: results.flatMap((result, index) => {
        const pair = pairs[index];
        const label = pair.virtualCustomerId ? `${pair.realCustomerId}->${pair.virtualCustomerId}` : String(pair.realCustomerId);
        return (result.diagnostics || []).map((item) => `${label} ${item}`);
      }),
    };
  }

  function resolveTencentDemandPolicy(detail, realCustomerIds, virtualCustomerIds, catalog) {
    const virtualTexts = normalizeBusinessIds(virtualCustomerIds).map((id) => catalog.virtualSearch?.get(String(id)) || catalog.virtual?.get(String(id)) || '').join(' ');
    if (!/(?:\u5b9a\u5411\s*j|direction\s*j)/i.test(virtualTexts)) return { type: 'standard', label: '标准匹配' };
    const realTexts = normalizeBusinessIds(realCustomerIds).map((id) => catalog.realSearch?.get(String(id)) || catalog.real?.get(String(id)) || '').join(' ');
    const hasT1 = /\bt1\b/i.test(realTexts);
    const hasT2 = /\bt2\b/i.test(realTexts);
    const hasT4 = /\bt4\b/i.test(realTexts);
    if (hasT1) return { type: 't1-fixed', label: '定向J + T1：上报地区和运营商锁定' };
    if (hasT2) {
      const nominal = detail?.nominalInfo || {};
      const isLocalMobile = String(nominal.isp || '') === '绉诲姩' && !(nominal.scheduleISPs || []).length && (Number(nominal.originTransProvRate) || 0) === 0;
      return isLocalMobile
        ? { type: 't2-mobile-local', label: '定向J + T2 本网移动本省：仅尝试上报电信/联通' }
        : { type: 't2-fixed-province', label: '定向J + T2：上报地区锁定' };
    }
    if (hasT4) return { type: 't4-adaptive', label: '定向J + T4：允许调整上报地区和运营商' };
    return { type: 'standard', label: '标准匹配' };
  }

  function resolveDemandBaseReporting(nominal = {}, adaptivePolicy = {}) {
    // Demand matching should prefer the node's physical province/city/isp.
    // Prior reporting overrides are only a fallback when the physical fields
    // are missing; otherwise they can poison the next business match.
    const hasReportingOverride = Boolean(nominal.bizProvince || nominal.bizCity || nominal.bizIsp);
    const province = nominal.province || nominal.bizProvince || '';
    const city = nominal.city || nominal.bizCity || '';
    const isp = nominal.isp || nominal.bizIsp || '';
    const source = nominal.province || nominal.city || nominal.isp ? 'physical' : (hasReportingOverride ? 'reporting' : 'physical');
    return { province, city, isp, source };
  }

  async function fetchDemandCandidates(detail, realCustomerId, virtualCustomerId, catalog, adaptivePolicy = { type: 'standard', label: '标准匹配' }) {
    const nominal = detail.nominalInfo || {};
    const scheduleIsps = nominal.scheduleISPs || [];
    const transProvRate = Number(scheduleIsps.length ? nominal.scheduleTransProvRate : nominal.originTransProvRate) || 0;
    const params = new URLSearchParams({
      size: '1000',
      demandFilter: 'unlimited',
      activated: 'true',
      isFilterCollectionClaim: 'true',
      customerId: String(virtualCustomerId || realCustomerId),
      isIPv6Schedule: String(Boolean(nominal.isIPv6Schedule)),
    });
    if (virtualCustomerId) {
      params.set('realCustomerId', String(realCustomerId));
      // Match NiuLink's information-edit form. When cross-ISP scheduling is set,
      // the platform omits cross-province/cross-ISP filters from demand lookup.
      // Adding them here can select a different demand order for the same business.
      if (!scheduleIsps.length) {
        const originTransProvRate = Number(nominal.originTransProvRate) || 0;
        params.set('isTransProv', String(originTransProvRate > 0));
        params.set('transProvRate', String(originTransProvRate));
      }
    } else {
      // NiuLink's real-business form currently sends these two fields, while some
      // older routes omit them. The fallback list below supports both contracts.
      params.set('isTransProv', String(transProvRate > 0));
      params.set('transProvRate', String(transProvRate));
    }
    const reportingBase = resolveDemandBaseReporting(nominal, adaptivePolicy);
    const { province, isp } = reportingBase;
    if (province) params.set('province', province);
    if (isp) params.set('isp', isp);
    if (nominal.webPort) params.set('webPort', nominal.webPort);
    if (nominal.resourceType) params.set('resourceType', nominal.resourceType);
    const response = await request(`${DEMAND_API}?${params.toString()}`, { method: 'GET' });
    let candidates = mapDemandCandidates(response?.items || [], catalog, province, isp)
      .filter((candidate) => demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId));
    let matchMode = '严格匹配';
    const diagnostics = [`严格匹配：${candidates.length} 条`];

    if (!candidates.length && adaptivePolicy.type === 't2-mobile-local') {
      for (const nextIsp of ['电信', '联通']) {
        const adaptiveParams = new URLSearchParams(params);
        adaptiveParams.set('isp', nextIsp);
        const attempts = [{ label: `腾讯 T2 上报${nextIsp}`, params: adaptiveParams }]
          .concat(buildSafeShapeFallbackQueries(adaptiveParams))
          .concat(buildTencentReportingDiscoveryQueries(adaptiveParams));
        for (const attempt of attempts.slice(0, 1)) {
          const adaptiveResponse = await request(`${DEMAND_API}?${attempt.params.toString()}`, { method: 'GET' });
          const adaptiveCandidates = mapDemandCandidates(adaptiveResponse?.items || [], catalog, province, nextIsp)
            .filter((candidate) => demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId))
            .filter((candidate) => candidateMatchesReporting(candidate, province, nextIsp))
            .filter((candidate) => candidateMatchesFixedNetwork(candidate, transProvRate, scheduleIsps, nominal))
            .map((candidate) => ({ ...candidate, reportingOverride: { bizIsp: nextIsp, reason: `定向J + T2 本网移动本省，按规则改上报运营商为 ${nextIsp}` } }));
          diagnostics.push(`${attempt.label}：${adaptiveCandidates.length} 条`);
          if (adaptiveCandidates.length) {
            candidates = adaptiveCandidates;
            matchMode = attempt.label;
            break;
          }
        }
        if (candidates.length) break;
      }
    }

    if (!PLATFORM_EXACT_DEMAND_MATCHING && !candidates.length && adaptivePolicy.type === 't4-adaptive') {
      const adaptiveParams = new URLSearchParams(params);
      adaptiveParams.delete('province');
      adaptiveParams.delete('isp');
      const attempts = [{ label: '腾讯 T4 自适应地区/运营商', params: adaptiveParams }]
        .concat(buildSafeShapeFallbackQueries(adaptiveParams))
        .concat(buildTencentReportingDiscoveryQueries(adaptiveParams));
      for (const attempt of attempts) {
        const adaptiveResponse = await request(`${DEMAND_API}?${attempt.params.toString()}`, { method: 'GET' });
        const adaptiveCandidates = mapDemandCandidates(adaptiveResponse?.items || [], catalog, province, isp)
          .filter((candidate) => demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId))
          .filter((candidate) => candidateMatchesFixedNetwork(candidate, transProvRate, scheduleIsps, nominal))
          .map((candidate) => ({ ...candidate, reportingOverride: buildT4ReportingOverride(candidate, province, isp) }))
          .filter((candidate) => candidate.reportingOverride);
        diagnostics.push(`${attempt.label}：${adaptiveCandidates.length} 条`);
        if (adaptiveCandidates.length) {
          candidates = adaptiveCandidates;
          matchMode = attempt.label;
          break;
        }
      }
    }

    if (!candidates.length && ['t1-fixed', 't2-fixed-province'].includes(adaptivePolicy.type)) {
      for (const attempt of buildSafeShapeFallbackQueries(params)) {
        const safeResponse = await request(`${DEMAND_API}?${attempt.params.toString()}`, { method: 'GET' });
        const safeCandidates = mapDemandCandidates(safeResponse?.items || [], catalog, province, isp)
          .filter((candidate) => demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId))
          .filter((candidate) => candidateMatchesReporting(candidate, province, isp));
        diagnostics.push(`${attempt.label}：${safeCandidates.length} 条`);
        if (safeCandidates.length) {
          candidates = safeCandidates;
          matchMode = attempt.label;
          break;
        }
      }
    }

    // Tencent rules never use generic geographic fallbacks that could silently bypass fixed fields.
    // Keep the same virtual-demand fallback order as niulink_tool for all other businesses.
    if (!candidates.length && !['standard', 't4-adaptive'].includes(adaptivePolicy.type)) {
      diagnostics.push(`${adaptivePolicy.label}：未使用会绕过规则的通用回退`);
    } else if ((adaptivePolicy.type === 'standard' || !PLATFORM_EXACT_DEMAND_MATCHING) && !hasDemandCapacityCandidate(candidates, detail)) {
    // Keep the same virtual-demand fallback order as niulink_tool. A fallback only expands
    // the visible candidates; the operator must still choose a demand order manually.
    if (!hasDemandCapacityCandidate(candidates, detail)) {
      const fallbackQueries = virtualCustomerId
        ? buildVirtualDemandFallbackQueries(params)
        : buildRealDemandFallbackQueries(params);
      for (const fallback of fallbackQueries) {
        const fallbackResponse = await request(`${DEMAND_API}?${fallback.params.toString()}`, { method: 'GET' });
        const fallbackCandidates = mapDemandCandidates(fallbackResponse?.items || [], catalog, province, isp)
          .filter((candidate) => demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId));
        diagnostics.push(`${fallback.label}：${fallbackCandidates.length} 条`);
        if (fallbackCandidates.length) {
          candidates = mergeDemandCandidates(candidates, fallbackCandidates);
          matchMode = matchMode === '严格匹配' ? fallback.label : `${matchMode} / ${fallback.label}`;
        }
      }
    }
    }
    if (!hasDemandCapacityCandidate(candidates, detail) && ['standard', 't4-adaptive'].includes(adaptivePolicy.type)) {
      const discoveredCandidates = await discoverAndReplayReportingCandidates(
        params,
        realCustomerId,
        virtualCustomerId,
        catalog,
        (candidate) => candidateMatchesFixedNetwork(candidate, transProvRate, scheduleIsps, nominal),
        (candidate) => adaptivePolicy.type === 't4-adaptive'
          ? buildT4ReportingOverride(candidate, province, isp)
          : virtualCustomerId
            ? buildVirtualDemandReportingOverride(candidate, nominal, reportingBase)
            : buildPlatformDemandReportingOverride(candidate, reportingBase)
      );
      diagnostics.push(`platform reporting replay: ${discoveredCandidates.length} candidates`);
      if (discoveredCandidates.length) {
        candidates = mergeDemandCandidates(candidates, discoveredCandidates);
        matchMode = matchMode === '严格匹配'
          ? '平台上报属性精确回放'
          : `${matchMode} / 平台上报属性精确回放`;
      }
    }
    if (adaptivePolicy.type === 't4-adaptive') {
      candidates = candidates.map((candidate) => ({
        ...candidate,
        reportingOverride: candidate.reportingOverride || buildT4ReportingOverride(candidate, province, isp),
      })).filter((candidate) => candidate.reportingOverride);
    }
    if (virtualCustomerId && adaptivePolicy.type === 'standard') {
      candidates = candidates.map((candidate) => ({
        ...candidate,
        reportingOverride: buildVirtualDemandReportingOverride(candidate, nominal, reportingBase),
      }));
    }
    const criteria = {
      customerId: String(virtualCustomerId || realCustomerId),
      realCustomerId: virtualCustomerId ? String(realCustomerId) : '',
      province: province || '',
      isp: isp || '',
      webPort: nominal.webPort || '',
      resourceType: nominal.resourceType || '',
      transProvRate,
      isTransISP: Boolean(scheduleIsps.length),
      isIPv6Schedule: Boolean(nominal.isIPv6Schedule),
      matchMode,
      adaptivePolicy: adaptivePolicy.label,
      reportingBase: reportingBase.source,
    };
    return { candidates, criteria, diagnostics };
  }

  function hasDemandCapacityCandidate(candidates, detail) {
    const requiredBandwidth = getNodeConstructionBandwidth(detail);
    return (candidates || []).some((candidate) => {
      if (candidate?.bandwidthUnlimited === true) return true;
      const remainingBandwidth = Number(candidate?.unclaimedBw);
      if (!Number.isFinite(remainingBandwidth)) return false;
      return Number.isFinite(requiredBandwidth) && requiredBandwidth > 0
        ? remainingBandwidth >= requiredBandwidth
        : remainingBandwidth > 0;
    });
  }

  async function discoverAndReplayReportingCandidates(params, realCustomerId, virtualCustomerId, catalog, predicate, buildOverride) {
    // Discovery is read-only and intentionally omits only reporting fields. Every
    // result is then replayed through the exact platform query before it is shown.
    const discoveryParams = new URLSearchParams(params);
    discoveryParams.delete('province');
    discoveryParams.delete('isp');
    const discoveryResponse = await request(`${DEMAND_API}?${discoveryParams.toString()}`, { method: 'GET' });
    const discoveryCandidates = mapDemandCandidates(discoveryResponse?.items || [], catalog)
      .filter((candidate) => demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId))
      .filter((candidate) => candidate.provinces.length && candidate.isp)
      .filter((candidate) => !predicate || predicate(candidate));
    const replayKeys = Array.from(new Set(discoveryCandidates.flatMap((candidate) =>
      candidate.provinces.map((province) => `${province}\u0000${candidate.isp}`)
    ))).slice(0, 120);
    const replayed = await mapConcurrent(replayKeys, 5, async (key) => {
      const [province, isp] = key.split('\u0000');
      const exactParams = new URLSearchParams(params);
      exactParams.set('province', province);
      exactParams.set('isp', isp);
      const response = await request(`${DEMAND_API}?${exactParams.toString()}`, { method: 'GET' });
      return mapDemandCandidates(response?.items || [], catalog)
        .filter((candidate) => demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId))
        .filter((candidate) => candidateMatchesReporting(candidate, province, isp))
        .filter((candidate) => !predicate || predicate(candidate))
        .map((candidate) => ({ ...candidate, reportingOverride: buildOverride(candidate) }));
    });
    return mergeDemandCandidates(...replayed);
  }

  function buildPlatformDemandReportingOverride(candidate, reportingBase = {}) {
    const currentProvince = reportingBase.province || '';
    const currentCity = reportingBase.city || '';
    const currentIsp = reportingBase.isp || '';
    const provinces = candidate?.provinces || [];
    const bizProvince = provinces.includes(currentProvince) ? currentProvince : (provinces[0] || currentProvince);
    const bizCity = resolveReportingCity(candidate, bizProvince, currentProvince, currentCity);
    const bizIsp = candidate?.isp || currentIsp;
    if (!bizProvince && !bizIsp) return null;
    return {
      ...(bizProvince ? { bizProvince } : {}),
      ...(bizCity ? { bizCity } : {}),
      ...(bizIsp ? { bizIsp } : {}),
      reason: '平台信息编辑精确查询确认的上报属性',
    };
  }

  function resolveDefaultReportingCity(province) {
    return DEFAULT_REPORTING_CITY_BY_PROVINCE[String(province || '').trim()] || '';
  }

  function completeReportingOverride(reportingOverride, nominal = {}) {
    if (!reportingOverride) return null;
    const override = { ...reportingOverride };
    if (override.bizProvince && !override.bizCity) {
      override.bizCity = resolveDefaultReportingCity(override.bizProvince) || nominal.bizCity || nominal.city || override.bizProvince;
    }
    if ((override.bizProvince || override.bizCity) && !override.bizIsp) {
      override.bizIsp = nominal.bizIsp || nominal.isp || '';
      if (!override.bizIsp) delete override.bizIsp;
    }
    return override;
  }

  function resolveReportingCity(candidate, bizProvince, currentProvince = '', currentCity = '') {
    const province = String(bizProvince || '').trim();
    // 信息编辑里的“客户上报省份/城市”是级联字段。平台只改省份时城市不会自动落值，
    // 所以按省份统一补该省默认第一个城市，避免出现需求单匹配了吉林但回读仍缺城市/省份不生效。
    const defaultCity = resolveDefaultReportingCity(province);
    if (defaultCity) return defaultCity;
    const candidateCities = Array.isArray(candidate?.cities)
      ? candidate.cities.map(String).filter(Boolean)
      : candidate?.city
        ? [String(candidate.city)]
        : [];
    if (candidateCities.length) return candidateCities[0];
    if (province && province === String(currentProvince || '').trim() && currentCity) return currentCity;
    return province || '';
  }

  function mergeDemandCandidates(...candidateLists) {
    return Array.from(new Map(
      candidateLists.flat()
        .filter((candidate) => candidate?.id)
        .map((candidate) => [candidate.id, candidate])
    ).values());
  }

  function buildT4ReportingOverride(candidate, province, isp) {
    const candidateProvinces = candidate?.provinces || [];
    // A multi-province demand accepts every listed province. Prefer the current
    // report province, otherwise select its first declared compatible province.
    const bizProvince = candidateProvinces.includes(String(province || ''))
      ? province
      : (candidateProvinces[0] || province);
    const bizCity = resolveReportingCity(candidate, bizProvince);
    const bizIsp = candidate?.isp || isp;
    const changed = bizProvince !== province || bizCity || bizIsp !== isp;
    return {
      ...(bizProvince ? { bizProvince } : {}),
      ...(bizCity ? { bizCity } : {}),
      ...(bizIsp ? { bizIsp } : {}),
      reason: changed
        ? `定向J + T4，按需求单调整上报地区为 ${bizProvince || '--'}${bizCity ? `/${bizCity}` : ''}、上报运营商为 ${bizIsp || '--'}`
        : '定向J + T4，需求单与原上报属性一致',
    };
  }

  function buildVirtualDemandReportingOverride(candidate, nominal = {}, reportingBase = {}) {
    const currentProvince = reportingBase.province || nominal.bizProvince || nominal.province || '';
    const currentCity = reportingBase.city || nominal.bizCity || nominal.city || '';
    const currentIsp = reportingBase.isp || nominal.bizIsp || nominal.isp || '';
    const physicalProvince = nominal.province || '';
    const physicalCity = nominal.city || '';
    const physicalIsp = nominal.isp || '';
    const candidateProvinces = candidate?.provinces || [];
    const bizProvince = candidateProvinces.includes(String(currentProvince))
      ? currentProvince
      : (candidateProvinces[0] || currentProvince);
    const bizCity = resolveReportingCity(candidate, bizProvince, currentProvince, currentCity);
    const bizIsp = candidate?.isp || currentIsp;
    if (!candidateProvinces.length && !candidate?.isp) return null;
    if (bizProvince === physicalProvince && bizCity === physicalCity && bizIsp === physicalIsp) {
      return null;
    }
    return {
      ...(bizProvince ? { bizProvince } : {}),
      ...(bizCity ? { bizCity } : {}),
      ...(bizIsp ? { bizIsp } : {}),
      reason: '虚拟业务需求单已声明上报属性，按所选需求单回填上报地区/运营商；不改变节点物理地域和物理运营商',
    };
  }

  function buildSafeShapeFallbackQueries(params) {
    const withoutPort = new URLSearchParams(params);
    withoutPort.delete('webPort');
    const withoutResource = new URLSearchParams(params);
    withoutResource.delete('resourceType');
    const withoutShape = new URLSearchParams(params);
    withoutShape.delete('webPort');
    withoutShape.delete('resourceType');
    return [
      { label: '保留上报地区/运营商，去掉端口', params: withoutPort },
      { label: '保留上报地区/运营商，去掉资源类型', params: withoutResource },
      { label: '保留上报地区/运营商，去掉端口和资源类型', params: withoutShape },
    ];
  }

  function buildTencentReportingDiscoveryQueries(params) {
    const withoutTransProv = new URLSearchParams(params);
    withoutTransProv.delete('isTransProv');
    withoutTransProv.delete('transProvRate');
    const withoutTransProvOrShape = new URLSearchParams(withoutTransProv);
    withoutTransProvOrShape.delete('webPort');
    withoutTransProvOrShape.delete('resourceType');
    return [
      { label: '保留网络属性，改由候选复核跨省', params: withoutTransProv },
      { label: '保留网络属性，去掉端口/资源类型后复核跨省', params: withoutTransProvOrShape },
    ];
  }

  function candidateMatchesFixedNetwork(candidate, transProvRate, scheduleIsps, nominal) {
    if (candidate.isIPv6Schedule !== Boolean(nominal?.isIPv6Schedule)) return false;
    if (candidate.transProvRate !== Number(transProvRate || 0)) return false;
    return candidate.isTransISP === Boolean((scheduleIsps || []).length);
  }

  function candidateMatchesReporting(candidate, province, isp) {
    const provinceMatches = !candidate.provinces?.length || candidate.provinces.includes(String(province || ''));
    const ispMatches = !candidate.isp || candidate.isp === isp;
    return provinceMatches && ispMatches;
  }

  function buildRealDemandFallbackQueries(strictParams) {
    const withoutTransProv = new URLSearchParams(strictParams);
    withoutTransProv.delete('isTransProv');
    withoutTransProv.delete('transProvRate');
    const withoutPort = new URLSearchParams(strictParams);
    withoutPort.delete('webPort');
    const withoutResource = new URLSearchParams(strictParams);
    withoutResource.delete('resourceType');
    const withoutShape = new URLSearchParams(strictParams);
    withoutShape.delete('webPort');
    withoutShape.delete('resourceType');
    const withoutGeography = new URLSearchParams(withoutShape);
    withoutGeography.delete('province');
    withoutGeography.delete('isp');
    const customerOnly = new URLSearchParams();
    ['size', 'demandFilter', 'activated', 'isFilterCollectionClaim', 'customerId'].forEach((key) => {
      if (strictParams.has(key)) customerOnly.set(key, strictParams.get(key));
    });
    return [
      { label: '平台兼容：不带跨省参数', params: withoutTransProv },
      { label: '去掉端口', params: withoutPort },
      { label: '去掉资源类型', params: withoutResource },
      { label: '去掉端口和资源类型', params: withoutShape },
      { label: '去掉地区、运营商、端口和资源类型', params: withoutGeography },
      { label: '仅按业务 ID', params: customerOnly },
    ];
  }

  function buildVirtualDemandFallbackQueries(strictParams) {
    const withoutProvince = new URLSearchParams(strictParams);
    withoutProvince.delete('province');
    const relaxedShape = new URLSearchParams(withoutProvince);
    relaxedShape.delete('webPort');
    relaxedShape.delete('resourceType');
    const withoutTransProv = new URLSearchParams(relaxedShape);
    withoutTransProv.delete('isTransProv');
    withoutTransProv.delete('transProvRate');
    withoutTransProv.delete('isTransISP');
    const realVirtualOnly = new URLSearchParams();
    ['size', 'demandFilter', 'activated', 'isFilterCollectionClaim', 'customerId', 'realCustomerId'].forEach((key) => {
      if (strictParams.has(key)) realVirtualOnly.set(key, strictParams.get(key));
    });
    return [
      { label: '去掉地区', params: withoutProvince },
      { label: '去掉地区、端口和资源类型', params: relaxedShape },
      { label: '去掉跨省、端口和资源类型', params: withoutTransProv },
      { label: '仅真实和虚拟业务', params: realVirtualOnly },
    ];
  }

  function mapDemandCandidates(items, catalog) {
    return (items || []).map((item) => {
      const bandwidth = parseDemandBandwidth(item);
      return {
        id: String(item.id || ''),
        ...bandwidth,
        customerDemandIds: item.customerDemandIds || [],
        customerIds: normalizeBusinessIds(item.customerIds || []),
        realCustomerIds: normalizeBusinessIds(item.realCustomerIds || []),
        businessNames: [
          ...(item.customerIds || []).map((id) => formatBusinessName(id, catalog.virtual?.has(String(id)) ? catalog.virtual : catalog.real)),
          ...(item.realCustomerIds || []).map((id) => formatBusinessName(id, catalog.real)),
        ].join(' → '),
        province: item.province || '',
        city: item.city || '',
        provinces: Array.isArray(item.provinces)
          ? item.provinces.map(String)
          : item.province
            ? [String(item.province)]
            : [],
        cities: Array.isArray(item.cities)
          ? item.cities.map(String)
          : item.city
            ? [String(item.city)]
            : [],
        isp: item.isp || '',
        webPort: String(item.webPort || ''),
        resourceType: String(item.resourceType || ''),
        isIPv6Schedule: Boolean(item.isIPv6Schedule),
        transProvRate: Number(item.transProvRate || 0),
        isTransISP: Boolean(item.isTransISP),
        // Only an explicit API confirmation may authorize cross-node demand reuse.
        claimable: item.claimable === true,
      };
    }).filter((item) => item.id).sort((left, right) => demandBandwidthValue(right) - demandBandwidthValue(left));
  }

  function demandCoversAllTargets(candidate, realCustomerIds, virtualCustomerIds) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    const customerIds = normalizeBusinessIds(candidate?.customerIds || []);
    const demandRealIds = normalizeBusinessIds(candidate?.realCustomerIds || []);
    if (virtualIds.length) {
      return virtualIds.every((id) => customerIds.includes(id)) && realIds.every((id) => demandRealIds.includes(id));
    }
    return realIds.every((id) => customerIds.includes(id) || demandRealIds.includes(id));
  }

  function scoreDemandCandidate(candidate, criteria = {}) {
    let score = 40;
    const reasons = ['业务完整覆盖 +40'];
    const add = (value, reason) => { score += value; reasons.push(`${reason} ${value >= 0 ? '+' : ''}${value}`); };
    const provinceMatches = !candidate.provinces.length || candidate.provinces.includes(String(criteria.province || ''));
    add(candidate.provinces.length ? (provinceMatches ? 20 : -25) : 6, candidate.provinces.length ? '地区' : '地区不限');
    add(!candidate.isp ? 6 : candidate.isp === criteria.isp ? 20 : -25, !candidate.isp ? '运营商不限' : '运营商');
    add(!candidate.webPort ? 4 : candidate.webPort === criteria.webPort ? 10 : -12, !candidate.webPort ? '端口不限' : '端口');
    add(!candidate.resourceType ? 4 : candidate.resourceType === criteria.resourceType ? 10 : -12, !candidate.resourceType ? '资源类型不限' : '资源类型');
    add(candidate.isIPv6Schedule === Boolean(criteria.isIPv6Schedule) ? 8 : -15, 'IPv6');
    add(candidate.transProvRate === Number(criteria.transProvRate || 0) ? 8 : -12, '跨省比例');
    add(candidate.isTransISP === Boolean(criteria.isTransISP) ? 8 : -12, '跨运营商');
    const capacityScore = candidate.bandwidthUnlimited === true
      ? 10
      : Math.min(10, Math.max(0, Math.log10(Math.max(1, candidate.unclaimedBw)) * 2));
    add(Math.round(capacityScore), '剩余带宽');
    // claimable=false means this demand cannot be claimed by more than one node.
    // It remains valid for a single node and must not lose its normal matching score.
    if (!candidate.claimable) add(0, '平台标记单节点（默认禁止跨节点复用）');
    return { score, scoreReasons: reasons };
  }

  function demandContainsTargetPair(candidate, realCustomerId, virtualCustomerId = null) {
    const realId = Number(realCustomerId);
    // Number(null) is 0. A real-only target must not be treated as virtual business ID 0.
    const hasVirtualTarget = virtualCustomerId !== null && virtualCustomerId !== undefined && String(virtualCustomerId).trim() !== '';
    const virtualId = hasVirtualTarget ? Number(virtualCustomerId) : null;
    const customerIds = normalizeBusinessIds(candidate?.customerIds || []);
    const realCustomerIds = normalizeBusinessIds(candidate?.realCustomerIds || []);
    if (Number.isFinite(virtualId)) {
      return customerIds.includes(virtualId) && realCustomerIds.includes(realId);
    }
    return customerIds.includes(realId) || realCustomerIds.includes(realId);
  }

  async function diagnoseDemandCandidates(params) {
    const withoutTransProv = new URLSearchParams(params);
    withoutTransProv.delete('isTransProv');
    withoutTransProv.delete('transProvRate');
    const customerOnly = new URLSearchParams();
    ['size', 'demandFilter', 'activated', 'isFilterCollectionClaim', 'customerId', 'realCustomerId'].forEach((key) => {
      if (params.has(key)) customerOnly.set(key, params.get(key));
    });
    const variants = [
      { label: '去掉端口', remove: ['webPort'] },
      { label: '去掉资源类型', remove: ['resourceType'] },
      { label: '去掉端口和资源类型', remove: ['webPort', 'resourceType'] },
      { label: '去掉地区和运营商', remove: ['province', 'isp'] },
      { label: '去掉跨省条件', params: withoutTransProv },
      { label: '仅按业务 ID', params: customerOnly },
    ];
    return Promise.all(variants.map(async (variant) => {
      try {
        const next = variant.params ? new URLSearchParams(variant.params) : new URLSearchParams(params);
        (variant.remove || []).forEach((key) => next.delete(key));
        const response = await request(`${DEMAND_API}?${next.toString()}`, { method: 'GET' });
        return `${variant.label}：${(response?.items || []).length} 条`;
      } catch (error) {
        return `${variant.label}：查询失败`;
      }
    }));
  }

  function renderDemandCandidates(container, results, demandMap, masterNodeId = null) {
    container.innerHTML = results.map((item) => {
      const role = masterNodeId ? (item.nodeId === masterNodeId ? '主' : '从') : '目标';
      if (item.error) return `<section class="nlnfm-demand-row nlnfm-error"><strong>${role} · ${escapeHtml(shortId(item.nodeId))}</strong><span>查询失败</span><details class="nlnfm-demand-detail"><summary>明细</summary><p>${escapeHtml(item.error)}</p></details></section>`;
      if (!item.candidates.length) {
        return `<section class="nlnfm-demand-row nlnfm-error"><strong>${role} · ${escapeHtml(shortId(item.nodeId))}</strong><span>没有可选需求单</span><details class="nlnfm-demand-detail"><summary>查看原因</summary><p>${escapeHtml((item.diagnostics || []).join('；') || item.criteria?.matchMode || '无更多信息')}</p></details></section>`;
      }
      const decision = item.matchingDecision || decideDemandSelection(item, {});
      item.matchingDecision = decision;
      item.reportingSyncPlan = decision.reportingSyncPlan;
      const options = ['<option value="">请选择需求单</option>'].concat(item.candidates.map((candidate) => {
        const selected = demandMap[item.nodeId] === candidate.id ? ' selected' : '';
        const reuseLabel = candidate.claimable === true ? '可复用' : '平台标单节点';
        return `<option value="${escapeHtml(candidate.id)}"${selected}>[${reuseLabel}] ${escapeHtml(candidate.id)} · 带宽 ${escapeHtml(formatCandidateDemandBandwidth(candidate))}</option>`;
      })).join('');
      const selectedCandidate = item.candidates.find((candidate) => candidate.id === demandMap[item.nodeId]) || decision.selectedCandidate;
      const evidence = selectedCandidate?.scoreReasons?.join('；') || decision?.diagnostics?.reason || '候选存在歧义，等待人工选择';
      const syncPlan = selectedCandidate ? buildReportingSyncPlan(item.matchingContext || buildMatchingContext(item.detail), selectedCandidate) : decision.reportingSyncPlan;
      const syncText = syncPlan?.required ? `；需同步上报 ${escapeHtml(syncPlan.target.province || '--')}/${escapeHtml(syncPlan.target.city || '--')}/${escapeHtml(syncPlan.target.isp || '--')}` : '';
      const statusText = decision.autoSelected && decision.selectedDemandId ? `已自动选择 ${escapeHtml(decision.selectedDemandId)}` : '需人工选择';
      return `<section class="nlnfm-demand-row"><strong>${role} · ${escapeHtml(shortId(item.nodeId))}</strong><select data-demand-node="${escapeHtml(item.nodeId)}">${options}</select><span>${item.candidates.length} 条 · ${statusText}${syncText}</span><details class="nlnfm-demand-detail"><summary>明细</summary><p title="${escapeHtml(evidence)}">${escapeHtml(evidence)}</p></details></section>`;
    }).join('');
  }
  function buildDemandEvidenceMap(results, demandMap) {
    return Object.fromEntries((results || []).map((item) => {
      const demandId = demandMap[item.nodeId];
      const candidate = item.candidates?.find((entry) => entry.id === demandId);
      if (!candidate) return [item.nodeId, '未选择有效候选需求单'];
      const reasons = candidate.scoreReasons?.join('；') || '无说明';
      const overrideText = formatReportingOverride(candidate.reportingOverride);
      return [
        item.nodeId,
        `${reasons}；匹配方式 ${item.criteria?.matchMode || '严格匹配'}；${overrideText}；缺口带宽 ${formatCandidateDemandBandwidth(candidate)}`,
      ];
    }));
  }

  function buildSelectedDemandCandidateMap(results, demandMap) {
    return Object.fromEntries((results || []).map((item) => {
      const demandId = demandMap[item.nodeId];
      const candidate = item.candidates?.find((entry) => entry.id === demandId) || null;
      return [item.nodeId, candidate];
    }));
  }

  function buildReportingSyncPlanMap(results, demandMap) {
    return Object.fromEntries((results || []).map((item) => {
      const selectedDemandId = demandMap[item.nodeId];
      const decision = item.matchingDecision || null;
      const candidate = item.candidates?.find((entry) => entry.id === selectedDemandId) || decision?.selectedCandidate || null;
      const context = item.matchingContext || buildMatchingContext(item.detail);
      return [item.nodeId, candidate ? buildReportingSyncPlan(context, candidate) : null];
    }));
  }

  function buildReportingOverrideMap(results, demandMap) {
    const syncPlanMap = buildReportingSyncPlanMap(results, demandMap);
    return Object.fromEntries(Object.entries(syncPlanMap).map(([nodeId, plan]) => [nodeId, plan?.reportingOverride || null]));
  }
  function formatReportingOverride(override) {
    if (!override) return '上报属性保持不变';
    const parts = [];
    if (override.bizProvince) parts.push(`上报地区→${override.bizProvince}${override.bizCity ? `/${override.bizCity}` : ''}`);
    if (override.bizIsp) parts.push(`上报运营商→${override.bizIsp}`);
    return parts.length ? `${parts.join('；')}；${override.reason || '规则允许'}` : (override.reason || '上报属性保持不变');
  }

  function describeReportingPlan(detail, override) {
    const nominal = detail?.nominalInfo || {};
    const currentProvince = nominal.bizProvince || nominal.province || '--';
    const currentCity = nominal.bizCity || nominal.city || '--';
    const currentIsp = nominal.bizIsp || nominal.isp || '--';
    const nextProvince = override?.bizProvince || currentProvince;
    const nextCity = override?.bizCity || currentCity;
    const nextIsp = override?.bizIsp || currentIsp;
    if (nextProvince === currentProvince && nextCity === currentCity && nextIsp === currentIsp) {
      return `上报地区/运营商保持 ${currentProvince}/${currentCity}/${currentIsp}`;
    }
    return `上报地区 ${currentProvince}/${currentCity}→${nextProvince}/${nextCity}；上报运营商 ${currentIsp}→${nextIsp}`;
  }

  function formatDemandBandwidth(value) {
    if (value === Infinity) return '不限';
    const mbps = Number(value || 0);
    return `${Number.isFinite(mbps) ? mbps : 0} Mbps`;
  }

  function formatCandidateDemandBandwidth(candidate) {
    return candidate?.bandwidthUnlimited === true ? '不限' : formatDemandBandwidth(candidate?.unclaimedBw);
  }

  function formatPreviewDemandId(item = {}) {
    return item.demandId || item.selectedDemand?.id || '--';
  }

  function formatNodeCarrierRegion(item = {}) {
    const nominal = item.detail?.nominalInfo || {};
    const isp = nominal.isp || '--';
    const province = nominal.province || '--';
    const city = nominal.city || '--';
    return `${isp} · ${province}/${city}`;
  }

  function formatCustomerReportingAfterMatch(item = {}) {
    const nominal = item.detail?.nominalInfo || {};
    const plan = item.reportingSyncPlan || null;
    const target = plan?.target || {};
    const province = target.province || target.bizProvince || nominal.bizProvince || nominal.province || '--';
    const city = target.city || target.bizCity || nominal.bizCity || nominal.city || '--';
    const isp = target.isp || target.bizIsp || nominal.bizIsp || nominal.isp || '--';
    return `${isp} · ${province}/${city}`;
  }

  function formatDemandCriteria(criteria = {}) {
    const parts = [
      `业务 ${criteria.customerId || '--'}`,
      `匹配 ${criteria.matchMode || '严格匹配'}`,
    ].filter(Boolean);
    return parts.join('；');
  }

  async function getBusinessCatalog() {
    if (state.businessCatalog) return state.businessCatalog;
    const empty = { real: new Map(), virtual: new Map(), realSearch: new Map(), virtualSearch: new Map(), virtualAssociations: new Map() };
    try {
      const [realResponse, virtualResponse] = await Promise.all([
        request(`${CUSTOMERS_API}?page=1&size=999&sortKey=name&sortType=asc`, { method: 'GET' }),
        request(`${VIRTUAL_CUSTOMERS_API}?page=1&size=999`, { method: 'GET' }),
      ]);
      (realResponse?.items || []).forEach((item) => {
        const id = String(item.id);
        const name = String(item.name || item.id);
        empty.real.set(id, name);
        empty.realSearch.set(id, buildBusinessSearchText(item, name, id));
      });
      (virtualResponse?.items || []).forEach((item) => {
        const id = String(item.id);
        const name = String(item.externalName || item.name || item.signName || item.id);
        empty.virtual.set(id, name);
        empty.virtualSearch.set(id, buildBusinessSearchText(item, name, id));
        empty.virtualAssociations.set(id, clone(item.associatedCustomers || []));
      });
    } catch (error) {
      log('business name lookup failed', error);
    }
    state.businessCatalog = empty;
    return empty;
  }

  function buildBusinessSearchText(item, name, id) {
    const tokens = [name, id];
    const collect = (value, key = '') => {
      if (value == null) return;
      if (Array.isArray(value)) return value.forEach((entry) => collect(entry, key));
      if (typeof value === 'object') {
        Object.entries(value).forEach(([childKey, childValue]) => {
          if (/(?:code|business|biz|customer|short|alias|sign|name|label|tag)/i.test(childKey)) collect(childValue, childKey);
        });
        return;
      }
      if (/(?:code|business|biz|customer|short|alias|sign|name|label|tag)/i.test(key)) tokens.push(String(value));
    };
    collect(item);
    return Array.from(new Set(tokens.map((token) => String(token || '').trim().toLowerCase()).filter(Boolean))).join(' ');
  }

  function formatBusinessName(id, names) {
    const key = String(id || '');
    if (!key) return '--';
    const name = names?.get(key);
    return name ? `${name} (${key})` : key;
  }

  function formatBusinessNames(ids, names) {
    const normalized = normalizeBusinessIds(ids);
    return normalized.length ? normalized.map((id) => formatBusinessName(id, names)).join(' + ') : '--';
  }

  function formatDefaultRealMappings(mappings, catalog) {
    return (mappings || []).map((item) => `${formatBusinessName(item.virtualId, catalog?.virtual)} → ${formatBusinessName(item.realId, catalog?.real)}`).join('；');
  }

  function formatDeliveryBusiness(realCustomerIds = [], virtualCustomerIds = [], catalog = null) {
    const realText = formatBusinessNames(realCustomerIds, catalog?.real);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    if (!virtualIds.length) return realText;
    return `${formatBusinessNames(virtualIds, catalog?.virtual)} → ${realText}`;
  }

  async function openAcceptanceDialog(initiator = '鐭夸富') {
    const ids = targetIds();
    if (!ids.length) return setNotice('请先锁定从节点或勾选操作目标。');
    const preview = await buildAcceptancePreview(ids, initiator);
    showBatchActionPreview(`强制验收预检（${initiator}发起）`, preview, async () => {
      const results = await mapConcurrent(preview.ready, WRITE_CONCURRENCY, async (item) => {
        try {
          await put(`${NODE_API}${item.nodeId}/acceptance`, buildAcceptancePayload(item.detail, initiator));
          return { nodeId: item.nodeId, ok: true };
        } catch (error) { return { nodeId: item.nodeId, ok: false, error: message(error) }; }
      });
      finishBatchAction('强制验收', results);
    });
  }

  async function buildBusinessSwitchPreview(ids, realCustomerIds, virtualCustomerIds, demandMap, demandEvidenceMap = {}, reportingOverrideMap = {}, reportingSyncPlanMap = {}, selectedDemandMap = {}, catalog = null) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    const items = await mapConcurrent(ids, 3, async (nodeId) => {
      try {
        const detail = await getNode(nodeId);
        const selectedDemand = selectedDemandMap[nodeId] || null;
        const reason = !BUSINESS_SWITCH_STAGES.has(detail.stage)
            ? '阶段不符'
            : !demandMap[nodeId]
              ? '未选需求单'
              : '';
        return {
          nodeId,
          detail,
          ok: !reason,
          reason,
          evidence: demandEvidenceMap[nodeId] || '--',
          demandId: demandMap[nodeId] || '',
          selectedDemand,
          deliveryBusinessText: formatDeliveryBusiness(realIds, virtualIds, catalog),
          reportingSyncPlan: reportingSyncPlanMap[nodeId] || null,
          summary: !reason
            ? `已匹配需求单${reportingSyncPlanMap[nodeId]?.required ? '，需先同步上报地区/运营商后再执行' : '，可直接执行'}`
            : reason,
        };
      } catch (error) { return { nodeId, ok: false, reason: message(error), label: '' }; }
    });
    return { items, ready: items.filter((item) => item.ok) };
  }

  async function buildBusinessResubmitPreview(ids, realCustomerIds, virtualCustomerIds, demandMap, masterNodeId, demandEvidenceMap = {}, reportingOverrideMap = {}, reportingSyncPlanMap = {}, selectedDemandMap = {}, catalog = null) {
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    const items = await mapConcurrent(ids, 3, async (nodeId) => {
      try {
        const detail = await getNode(nodeId);
        const selectedDemand = selectedDemandMap[nodeId] || null;
        const reason = !BUSINESS_RESUBMIT_STAGES.has(detail.stage)
            ? '阶段不符'
            : !demandMap[nodeId]
              ? '未选需求单'
              : '';
        const role = masterNodeId ? (nodeId === masterNodeId ? '主节点' : '从节点') : '目标节点';
        const flow = detail.stage === 'uncensored' ? '信息更新 + 重新提交审核' : '更新待验收目标业务';
        return {
          nodeId,
          detail,
          ok: !reason,
          reason,
          evidence: demandEvidenceMap[nodeId] || '--',
          demandId: demandMap[nodeId] || '',
          selectedDemand,
          deliveryBusinessText: formatDeliveryBusiness(realIds, virtualIds, catalog),
          reportingSyncPlan: reportingSyncPlanMap[nodeId] || null,
          summary: !reason
            ? `${role}，${flow}${reportingSyncPlanMap[nodeId]?.required ? '，需先同步上报地区/运营商后再执行' : '，可直接执行'}`
            : reason,
        };
      } catch (error) {
        return { nodeId, detail: null, ok: false, reason: message(error), label: '' };
      }
    });
    return { items, ready: items.filter((item) => item.ok) };
  }

  async function buildAcceptancePreview(ids, initiator, masterVirtualCustomers = null) {
    const items = await mapConcurrent(ids, 3, async (nodeId) => {
      try {
        const detail = await getNode(nodeId);
        let reason = !['submitted', 'uncensored'].includes(detail.stage) ? `阶段 ${detail.stage || '--'} 不允许强制验收` : '';
        if (!reason) {
          try { buildAcceptancePayload(detail, initiator, masterVirtualCustomers); } catch (error) { reason = message(error); }
        }
        const virtualLabel = Array.isArray(masterVirtualCustomers) && masterVirtualCustomers.length ? '，同步主节点虚拟业务' : '';
        return { nodeId, detail, ok: !reason, reason, label: `${initiator}发起${virtualLabel}` };
      } catch (error) { return { nodeId, ok: false, reason: message(error), label: '' }; }
    });
    return { items, ready: items.filter((item) => item.ok) };
  }

  function showBatchActionPreview(title, preview, submit) {
    removeActionDialog();
    const dialog = document.createElement('section');
    dialog.id = 'nlnfm-action-dialog';
    const readyIds = preview.ready.map((item) => item.nodeId);
    const blockedIds = preview.items.filter((item) => !item.ok).map((item) => item.nodeId);
    const allIds = preview.items.map((item) => item.nodeId);
    const rows = preview.items.map((item) => {
      const resultText = item.ok ? '可执行' : '不可执行';
      const summaryText = item.summary || item.reason || '无补充说明';
      return `<div class="nlnfm-plan-row ${item.ok ? 'nlnfm-plan-ok' : 'nlnfm-plan-bad'}">
        <div class="nlnfm-plan-node"><span>节点 ID</span><div class="nlnfm-node-id-wrap"><code title="${escapeHtml(item.nodeId || '')}">${escapeHtml(item.nodeId || '')}</code><button type="button" data-copy-node-id="${escapeHtml(item.nodeId || '')}">复制</button></div></div>
        <div class="nlnfm-plan-meta"><span>交付业务</span><strong>${escapeHtml(item.deliveryBusinessText || '--')}</strong></div>
        <div class="nlnfm-plan-meta"><span>关联需求单</span><strong>${escapeHtml(formatPreviewDemandId(item))}</strong></div>
        <div class="nlnfm-plan-meta"><span>运营商/省份城市</span><strong>${escapeHtml(formatNodeCarrierRegion(item))}</strong></div>
        <div class="nlnfm-plan-meta"><span>客户上报运营商/省份城市</span><strong>${escapeHtml(formatCustomerReportingAfterMatch(item))}</strong></div>
        <div class="nlnfm-plan-result ${item.ok ? 'nlnfm-preview-ok' : 'nlnfm-preview-bad'}"><span>结果说明</span><strong>${escapeHtml(resultText)}</strong><small>${escapeHtml(summaryText)}</small></div>
      </div>`;
    }).join('');
    const syncCount = preview.items.filter((item) => item.reportingSyncPlan?.required).length;
    const idSummary = [
      `<div class="nlnfm-id-summary"><strong>可执行节点ID</strong><span>${readyIds.length}</span><button type="button" data-copy-ids="${escapeHtml(readyIds.join('\n'))}" ${readyIds.length ? '' : 'disabled'}>复制可执行</button></div>`,
      `<div class="nlnfm-id-summary"><strong>不可执行节点ID</strong><span>${blockedIds.length}</span><button type="button" data-copy-ids="${escapeHtml(blockedIds.join('\n'))}" ${blockedIds.length ? '' : 'disabled'}>复制不可执行</button></div>`,
      `<div class="nlnfm-id-summary"><strong>全部节点ID</strong><span>${allIds.length}</span><button type="button" data-copy-ids="${escapeHtml(allIds.join('\n'))}" ${allIds.length ? '' : 'disabled'}>复制全部</button></div>`,
    ].join('');
    dialog.innerHTML = `
      <div class="nlnfm-dialog-head"><strong>${escapeHtml(title)}</strong><button type="button" data-close-action>×</button></div>
      <p><b>DRY-RUN：</b>当前页面只展示执行计划，不会写入。预检完成：<b>${preview.ready.length}</b> / ${preview.items.length} 个节点可执行；阶段不匹配、缺少需求单或读取失败的节点不会写入。</p>
      ${syncCount ? `<p class="nlnfm-dialog-hint">其中 <b>${syncCount}</b> 个节点会先同步上报地区/运营商，再继续后续提交。</p>` : ''}
      ${idSummary}
      <div class="nlnfm-plan-list">${rows}</div>
      <footer><button type="button" data-close-action>取消</button><button type="button" class="nlnfm-picker-confirm" data-confirm-action ${preview.ready.length ? '' : 'disabled'}>确认真实写入 ${preview.ready.length} 个节点</button></footer>`;
    dialog.addEventListener('click', async (event) => {
      if (event.target.closest('[data-close-action]')) return removeActionDialog();
      const copyIdsButton = event.target.closest('[data-copy-ids]');
      if (copyIdsButton) {
        const text = String(copyIdsButton.dataset.copyIds || '').trim();
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          const previous = copyIdsButton.textContent;
          copyIdsButton.textContent = '已复制';
          setTimeout(() => { copyIdsButton.textContent = previous || '复制'; }, 800);
        } catch (error) {
          setNotice(`复制失败：${message(error)}`);
        }
        return;
      }
      const copyButton = event.target.closest('[data-copy-node-id]');
      if (copyButton) {
        const nodeId = String(copyButton.dataset.copyNodeId || '').trim();
        if (!nodeId) return;
        try {
          await navigator.clipboard.writeText(nodeId);
          const previous = copyButton.textContent;
          copyButton.textContent = '已复制';
          setTimeout(() => { copyButton.textContent = previous || '复制'; }, 800);
        } catch (error) {
          setNotice(`复制失败：${message(error)}`);
        }
        return;
      }
      const confirm = event.target.closest('[data-confirm-action]');
      if (!confirm || confirm.disabled) return;
      confirm.disabled = true;
      confirm.textContent = '执行中...';
      begin(`正在执行 ${title}：${preview.ready.length} 个节点...`);
      removeActionDialog();
      try { await submit(); } catch (error) { finish(`${title}执行失败：${message(error)}`); }
    });
    document.body.appendChild(dialog);
  }

  function removeActionDialog() { document.getElementById('nlnfm-action-dialog')?.remove(); }

  function finishBatchAction(name, results, suffix = '') {
    const success = results.filter((item) => item.ok).length;
    const failed = results.length - success;
    state.lastBatchResult = { name, results: clone(results || []), success, failed, at: new Date().toISOString() };
    writeAudit(name, { results, success, failed });
    finish(`${name}完成：成功 ${success}，失败 ${failed}。${suffix ? ` ${suffix}` : ''}`);
  }

  function failedLastBatchItems() {
    return (state.lastBatchResult?.results || []).filter((item) => !item.ok);
  }

  async function copyFailedNodeIds(button = null) {
    const ids = failedLastBatchItems().map((item) => item.nodeId).filter(Boolean);
    if (!ids.length) return setNotice('暂无失败节点可复制。');
    try {
      await navigator.clipboard.writeText(ids.join('\n'));
      if (button) {
        const previous = button.textContent;
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = previous || '复制失败ID'; }, 800);
      }
    } catch (error) {
      setNotice(`复制失败：${message(error)}`);
    }
  }

  function showFailureDetails() {
    const items = failedLastBatchItems();
    if (!items.length) return setNotice('暂无失败明细。');
    document.getElementById('nlnfm-failure-dialog')?.remove();
    const dialog = document.createElement('section');
    dialog.id = 'nlnfm-failure-dialog';
    const title = state.lastBatchResult?.name || '批量操作';
    const rows = items.map((item) => `
      <tr>
        <td><div class="nlnfm-node-id-wrap"><code title="${escapeHtml(item.nodeId || '')}">${escapeHtml(item.nodeId || '')}</code><button type="button" data-copy-node-id="${escapeHtml(item.nodeId || '')}">复制</button></div></td>
        <td>${escapeHtml(describeBatchOperation(item))}</td>
        <td>${escapeHtml(item.demandId || '--')}</td>
        <td class="nlnfm-preview-bad"><strong>${escapeHtml(describeFailureReason(item))}</strong><br><small>${escapeHtml(describeVerificationState(item))}</small></td>
      </tr>
    `).join('');
    dialog.innerHTML = `
      <div class="nlnfm-dialog-head"><strong>${escapeHtml(title)}失败明细（${items.length}）</strong><button type="button" data-close-failure>×</button></div>
      <p>这里展示最近一次批量执行失败的节点。原因优先取接口报错，其次取回读校验结果。</p>
      <div class="nlnfm-id-summary"><strong>失败节点ID</strong><span>${items.length}</span><button type="button" data-copy-failure-ids>复制全部失败ID</button></div>
      <div class="nlnfm-table"><table><thead><tr><th>节点 ID</th><th>操作</th><th>需求单</th><th>失败原因</th></tr></thead><tbody>${rows}</tbody></table></div>
      <footer><button type="button" data-close-failure>关闭</button></footer>`;
    dialog.addEventListener('click', async (event) => {
      if (event.target.closest('[data-close-failure]')) return dialog.remove();
      const copyAll = event.target.closest('[data-copy-failure-ids]');
      if (copyAll) return copyFailedNodeIds(copyAll);
      const copyButton = event.target.closest('[data-copy-node-id]');
      if (!copyButton) return;
      const nodeId = String(copyButton.dataset.copyNodeId || '').trim();
      if (!nodeId) return;
      try {
        await navigator.clipboard.writeText(nodeId);
        const previous = copyButton.textContent;
        copyButton.textContent = '已复制';
        setTimeout(() => { copyButton.textContent = previous || '复制'; }, 800);
      } catch (error) {
        setNotice(`复制失败：${message(error)}`);
      }
    });
    document.body.appendChild(dialog);
  }

  function describeBatchOperation(item = {}) {
    if (item.operation === 'resubmit') return '业务重提';
    if (item.operation === 'switch') return '业务切换';
    if (item.endpoint) return item.endpoint;
    return '批量操作';
  }

  function describeFailureReason(item = {}) {
    if (item.error) return item.error;
    const expectedStage = item.operation === 'resubmit' ? 'submitted' : 'censored / inService / submitted';
    if (item.verifiedStage) return `回读阶段为 ${item.verifiedStage}，未达到预期 ${expectedStage}`;
    if (item.dataeditVerifiedStage) return `信息编辑后阶段为 ${item.dataeditVerifiedStage}，后续提交未确认成功`;
    if (!item.demandId && ['resubmit', 'switch'].includes(item.operation)) return '缺少需求单';
    return '未通过检查或回读校验';
  }

  function describeVerificationState(item = {}) {
    const parts = [];
    if (item.verifiedStage) parts.push(`最终阶段：${item.verifiedStage}`);
    if (item.dataeditVerifiedStage) parts.push(`信息编辑后阶段：${item.dataeditVerifiedStage}`);
    if (item.reportingSyncRequired) {
      const target = item.reportingSyncTarget || {};
      parts.push(`上报同步目标：${[target.bizProvince, target.bizCity, target.bizIsp].filter(Boolean).join(' / ') || '--'}`);
    }
    if (item.realCustomerIds?.length) parts.push(`真实业务：${item.realCustomerIds.join('+')}`);
    if (item.virtualCustomerIds?.length) parts.push(`虚拟业务：${item.virtualCustomerIds.join('+')}`);
    return parts.join('；') || '没有更多回读信息';
  }

  function buildBusinessBatchResultSuffix(results, isResubmit) {
    const failed = (results || []).some((item) => !item.ok);
    if (failed) {
      return isResubmit
        ? '部分节点未通过检查或回读，请查看失败明细。'
        : '部分节点未通过检查或回读，请查看失败明细。';
    }
    return isResubmit
      ? '已回读确认进入 submitted。'
      : '已回读确认阶段、需求单和完整业务数组。';
  }

  function buildBusinessExecutionResult(nodeId, capturedTarget, demandId, isResubmit, ok, verified = null, error = null, dataeditVerified = null) {
    const reportingSyncPlan = capturedTarget?.reportingSyncPlan || null;
    return {
      nodeId,
      ok,
      operation: isResubmit ? 'resubmit' : 'switch',
      endpoint: isResubmit ? 'dataedit + doaction(reSubmitAfterUncensored)' : 'switchcustomer',
      demandId: demandId || null,
      realCustomerIds: normalizeBusinessIds(capturedTarget?.realCustomerIds),
      virtualCustomerIds: normalizeBusinessIds(capturedTarget?.virtualCustomerIds),
      reportingSyncRequired: Boolean(reportingSyncPlan?.required),
      reportingSyncTarget: reportingSyncPlan?.required ? clone(reportingSyncPlan.target || {}) : null,
      reportingSyncReason: reportingSyncPlan?.reason || '',
      dataeditVerifiedStage: dataeditVerified?.stage || null,
      dataeditVerifiedReporting: dataeditVerified ? {
        bizProvince: dataeditVerified?.nominalInfo?.bizProvince || '',
        bizCity: dataeditVerified?.nominalInfo?.bizCity || '',
        bizIsp: dataeditVerified?.nominalInfo?.bizIsp || '',
      } : null,
      verifiedStage: verified?.stage || null,
      verifiedReporting: verified ? {
        bizProvince: verified?.nominalInfo?.bizProvince || '',
        bizCity: verified?.nominalInfo?.bizCity || '',
        bizIsp: verified?.nominalInfo?.bizIsp || '',
      } : null,
      error: error ? message(error) : null,
    };
  }

  function parseDemandMap(text) {
    return Object.fromEntries(String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split('=').map((value) => value.trim())).filter((parts) => normalizeNodeId(parts[0]) && parts[1]).map(([nodeId, demandId]) => [normalizeNodeId(nodeId), demandId]));
  }

  function buildSwitchPayload(detail, realCustomerIds, virtualCustomerIds, demandId, capturedTarget = {}) {
    const payload = clone(detail.nominalInfo || {});
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    if (!realIds.length) throw new Error('缺少目标真实业务，不能提交业务切换。');
    payload.suggestCustomers = realIds;
    if (virtualIds.length) payload.virtualCustomers = virtualIds;
    else delete payload.virtualCustomers;
    payload.switchScenario = '供应商业务切换';
    payload.uncensoredRollBack = BUSINESS_RESUBMIT_STAGES.has(detail.stage) || Boolean(capturedTarget.uncensoredRollBack);
    payload.demandId = demandId;
    applyReportingOverride(payload, capturedTarget.reportingOverride);
    if (!capturedTarget.reportingOverride) clearReportingOverride(payload);
    return payload;
  }

  function buildBusinessResubmitDataeditPayload(detail, realCustomerIds, virtualCustomerIds, demandId, reportingOverride = null) {
    if (!demandId) throw new Error('缺少当前节点的 demandId。');
    const realIds = normalizeBusinessIds(realCustomerIds);
    const virtualIds = normalizeBusinessIds(virtualCustomerIds);
    if (!realIds.length) throw new Error('缺少目标真实业务。');
    const payload = buildDataeditPayload(detail, extractTemplate(detail), {
      schedule: false,
      ipSchedule: false,
      networkType: false,
      boardParams: false,
    });
    payload.nominal.suggestCustomers = realIds;
    if (virtualIds.length) {
      payload.nominal.virtualCustomers = virtualIds;
      // The portal edit flow keeps the selected virtual target and miner expectation in sync.
      payload.nominal.vendorSuggestCustomers = virtualIds;
    } else {
      delete payload.nominal.virtualCustomers;
    }
    payload.demandId = String(demandId);
    applyReportingOverride(payload.nominal, reportingOverride);
    if (!reportingOverride) clearReportingOverride(payload.nominal);
    return payload;
  }

  function applyReportingOverride(nominal, reportingOverride) {
    if (!nominal || !reportingOverride) return nominal;
    const override = completeReportingOverride(reportingOverride, nominal);
    if (override.bizProvince) nominal.bizProvince = override.bizProvince;
    if (override.bizCity) nominal.bizCity = override.bizCity;
    if (override.bizIsp) nominal.bizIsp = override.bizIsp;
    return nominal;
  }

  function clearReportingOverride(nominal) {
    if (!nominal) return nominal;
    delete nominal.bizProvince;
    delete nominal.bizCity;
    delete nominal.bizIsp;
    return nominal;
  }

  function buildReportingSyncDataeditPayload(detail, reportingOverride) {
    const payload = buildDataeditPayload(detail, extractTemplate(detail), {
      schedule: false,
      ipSchedule: false,
      networkType: false,
      boardParams: false,
    });
    applyReportingOverride(payload.nominal, reportingOverride);
    return payload;
  }

  async function verifyReportingSyncPlan(nodeId, reportingSyncPlan, context = '上报属性同步后') {
    if (!reportingSyncPlan?.reportingOverride) return getFreshNode(nodeId);
    let lastDetail = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await delay(500 * attempt);
      lastDetail = await getFreshNode(nodeId);
      if (reportingOverrideMatches(lastDetail?.nominalInfo || {}, reportingSyncPlan.reportingOverride)) return lastDetail;
    }
    const nominal = lastDetail?.nominalInfo || {};
    throw new Error(
      `${context}回读不一致：节点 ${normalizeNodeId(nodeId) || nodeId || '--'} 期望上报 ` +
      `${reportingSyncPlan.target?.province || '--'}/${reportingSyncPlan.target?.city || '--'}/${reportingSyncPlan.target?.isp || '--'}，` +
      `实际 ${(nominal.bizProvince || nominal.province || '--')}/${(nominal.bizCity || nominal.city || '--')}/${(nominal.bizIsp || nominal.isp || '--')}；` +
      `原因：${reportingSyncPlan.reason || '需求单要求同步上报属性'}。`
    );
  }

  async function applyReportingSyncPlan(nodeId, detail, reportingSyncPlan) {
    if (!reportingSyncPlan?.required || !reportingSyncPlan.reportingOverride) return detail;
    if (reportingOverrideMatches(detail?.nominalInfo || {}, reportingSyncPlan.reportingOverride)) return detail;
    await put(`${NODE_API}${nodeId}/dataedit`, buildReportingSyncDataeditPayload(detail, reportingSyncPlan.reportingOverride));
    return verifyReportingSyncPlan(nodeId, reportingSyncPlan);
  }

  async function executeBusinessSwitch(item, capturedTarget, demandId) {
    let detail = await getFreshNode(item.nodeId);
    if (!BUSINESS_SWITCH_STAGES.has(detail.stage)) {
      throw new Error(`执行前状态已变为 ${detail.stage || '--'}，业务切换已取消。`);
    }
    detail = await applyReportingSyncPlan(item.nodeId, detail, capturedTarget.reportingSyncPlan);
    await assertDemandStillAvailable(detail, capturedTarget, demandId);
    await put(`${NODE_API}${item.nodeId}/switchcustomer`, buildSwitchPayload(
      detail,
      capturedTarget.realCustomerIds,
      capturedTarget.virtualCustomerIds,
      demandId,
      { ...capturedTarget, uncensoredRollBack: false }
    ));
  }

  async function executeBusinessResubmit(item, capturedTarget, demandId) {
    let detail = await getFreshNode(item.nodeId);
    if (!BUSINESS_RESUBMIT_STAGES.has(detail.stage)) {
      throw new Error(`执行前状态已变为 ${detail.stage || '--'}，目标业务重提已取消。`);
    }
    detail = await applyReportingSyncPlan(item.nodeId, detail, capturedTarget.reportingSyncPlan);
    await assertDemandStillAvailable(detail, capturedTarget, demandId);
    let dataeditVerified = detail;
    if (!businessTargetMatches(detail, capturedTarget.realCustomerIds, capturedTarget.virtualCustomerIds, demandId, BUSINESS_RESUBMIT_STAGES) || !reportingOverrideMatches(detail.nominalInfo || {}, capturedTarget.reportingOverride)) {
      await put(
        `${NODE_API}${item.nodeId}/dataedit`,
        buildBusinessResubmitDataeditPayload(detail, capturedTarget.realCustomerIds, capturedTarget.virtualCustomerIds, demandId, capturedTarget.reportingOverride)
      );
      dataeditVerified = await verifySubmittedBusinessTarget(
        item.nodeId,
        capturedTarget.realCustomerIds,
        capturedTarget.virtualCustomerIds,
        demandId,
        BUSINESS_RESUBMIT_STAGES,
        'dataedit 后',
        capturedTarget.reportingOverride
      );
    }
    await put(`${NODE_API}${item.nodeId}/doaction`, {
      nodeId: item.nodeId,
      action: 'reSubmitAfterUncensored',
    });
    return dataeditVerified;
  }

  async function assertDemandStillAvailable(detail, capturedTarget, demandId) {
    if (!demandId) throw new Error('执行前缺少 demandId。');
    const catalog = await getBusinessCatalog();
    const demandRealCustomerIds = resolveDemandMatchingRealCustomerIds(
      capturedTarget.realCustomerIds,
      capturedTarget.virtualCustomerIds,
      catalog
    );
    const result = await fetchDemandCandidatesForTargets(
      detail,
      demandRealCustomerIds,
      capturedTarget.virtualCustomerIds,
      catalog
    );
    const candidate = result.candidates.find((item) => item.id === String(demandId));
    if (!candidate) {
      throw new Error(`执行前需求单 ${demandId} 已不可用或不再完整覆盖目标业务。`);
    }
    if (capturedTarget?.demandReuse?.enabled) {
      const requiredBandwidth = Number(capturedTarget.demandReuse.requiredBandwidth);
      if (!Number.isFinite(requiredBandwidth) || requiredBandwidth <= 0) {
        throw new Error(`执行前无法读取节点建设带宽，禁止复用需求单 ${demandId}。`);
      }
      const remaining = demandBandwidthValue(candidate);
      if (candidate.bandwidthUnlimited !== true && remaining < requiredBandwidth) {
        throw new Error(`执行前需求单 ${demandId} 剩余 ${formatDemandBandwidth(remaining)}，不足本节点建设带宽 ${formatDemandBandwidth(requiredBandwidth)}。`);
      }
    }
    if (!sameReportingOverride(candidate.reportingOverride, capturedTarget.reportingOverride)) {
      throw new Error('执行前需求单自适应方案已变化，请重新查询并预检，禁止沿用旧的上报属性修改计划。');
    }
    return candidate;
  }

  async function verifySubmittedBusinessTarget(nodeId, realCustomerIds, virtualCustomerIds, demandId = null, allowedStages = null, context = '提交后', reportingOverride = null) {
    const expectedReal = normalizeBusinessIds(realCustomerIds);
    const expectedVirtual = normalizeBusinessIds(virtualCustomerIds);
    let lastDetail = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await delay(500 * attempt);
      lastDetail = await getFreshNode(nodeId);
      if (businessTargetMatches(lastDetail, expectedReal, expectedVirtual, demandId, allowedStages) && reportingOverrideMatches(lastDetail?.nominalInfo || {}, reportingOverride)) return lastDetail;
    }
    const nominal = lastDetail?.nominalInfo || {};
    throw new Error(
      `${context}回读不一致：真实业务期望 ${expectedReal.join('+') || '--'}，实际 ${normalizeBusinessIds(nominal.suggestCustomers || []).join('+') || '--'}；` +
      `虚拟业务期望 ${expectedVirtual.join('+') || '--'}，实际 ${normalizeBusinessIds(nominal.virtualCustomers || []).join('+') || '--'}；` +
      `需求单期望 ${demandId || '--'}，实际 ${lastDetail?.demandId || '--'}；阶段 ${lastDetail?.stage || '--'}；` +
      `允许阶段 ${allowedStages ? Array.from(allowedStages).join('/') : '不限'}；${formatReportingOverride(reportingOverride)}`
    );
  }

  async function verifyResubmitSubmitted(nodeId, capturedTarget, demandId) {
    return verifySubmittedBusinessTarget(
      nodeId,
      capturedTarget.realCustomerIds,
      capturedTarget.virtualCustomerIds,
      demandId,
      BUSINESS_RESUBMIT_POST_STAGES,
      '重新提交后',
      capturedTarget.reportingOverride
    );
  }

  function reportingOverrideMatches(nominal, reportingOverride) {
    if (!reportingOverride) return true;
    return (!reportingOverride.bizProvince || nominal?.bizProvince === reportingOverride.bizProvince) &&
      (!reportingOverride.bizCity || nominal?.bizCity === reportingOverride.bizCity) &&
      (!reportingOverride.bizIsp || nominal?.bizIsp === reportingOverride.bizIsp);
  }

  function sameReportingOverride(left, right) {
    const a = left || {};
    const b = right || {};
    return (a.bizProvince || '') === (b.bizProvince || '') &&
      (a.bizCity || '') === (b.bizCity || '') &&
      (a.bizIsp || '') === (b.bizIsp || '');
  }

  function businessTargetMatches(detail, realCustomerIds, virtualCustomerIds, demandId = null, allowedStages = null) {
    const nominal = detail?.nominalInfo || {};
    const demandMatches = !demandId || String(detail?.demandId || '') === String(demandId);
    const stageMatches = !allowedStages || allowedStages.has(detail?.stage);
    return sameBusinessIds(nominal.suggestCustomers || [], realCustomerIds) &&
      sameBusinessIds(nominal.virtualCustomers || [], virtualCustomerIds) &&
      demandMatches && stageMatches;
  }

  function sameBusinessIds(left, right) {
    const a = normalizeBusinessIds(left).sort((x, y) => x - y);
    const b = normalizeBusinessIds(right).sort((x, y) => x - y);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function buildAcceptancePayload(detail, initiator, masterVirtualCustomers = null) {
    const nominal = detail.nominalInfo || {};
    const currentCustomerIds = (detail.customers || []).map((item) => Number(item.id)).filter(Number.isFinite);
    const suggestCustomers = initiator === '内部' ? currentCustomerIds : (nominal.suggestCustomers || []);
    if (!suggestCustomers.length) throw new Error('缺少 suggestCustomers，不能安全强制验收。');
    const payload = { bwNum: Number(nominal.bwNum), usbw: Number(nominal.usbw), conclusion: true, notes: clone(detail.notes || []), rejectionReason: '', suggestCustomers, vendorSuggestCustomers: clone(nominal.vendorSuggestCustomers || []) };
    if (!Number.isInteger(payload.bwNum) || !Number.isInteger(payload.usbw)) throw new Error('缺少节点带宽参数，不能强制验收。');
    // 主节点验收跟随时显式复制其虚拟业务；普通单节点验收仍保留从节点自身虚拟业务。
    const virtualCustomers = Array.isArray(masterVirtualCustomers) && masterVirtualCustomers.length
      ? normalizeBusinessIds(masterVirtualCustomers)
      : normalizeBusinessIds(nominal.virtualCustomers || []);
    if (virtualCustomers.length) payload.virtualCustomers = virtualCustomers;
    if (detail.demandId) payload.demandId = detail.demandId;
    if (detail.claimId) payload.claimId = detail.claimId;
    return payload;
  }

  function normalizeBusinessIds(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)));
  }

  function parseRecordedMutationPayload(body) {
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch (_) { return null; }
    }
    if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) return body;
    return null;
  }

  async function put(path, payload) {
    return request(path, { method: 'PUT', body: JSON.stringify(payload) });
  }

  async function request(path, init) {
    const authorization = await waitForAuthorization();
    if (!authorization) throw new Error('未捕获到页面授权。请先刷新页面并手动查询一次节点列表后重试。');
    const response = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: authorization },
      ...init,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data?.message || response.statusText || text.slice(0, 160)}`);
    return data?.data || data;
  }

  function selectedNodeIds() {
    return selectedNodeRecords().map((item) => item.nodeId);
  }

  function selectedNodeRecords() {
    const records = new Map();
    document.querySelectorAll('input[type="checkbox"]:checked').forEach((input) => {
      if (input.closest(`#${ROOT_ID}`) || input.closest('#nlnfm-preview')) return;
      const row = input.closest('tr');
      const id = findNodeId(row || input.parentElement);
      if (!id) return;
      const linkText = row?.querySelector('a')?.textContent?.replace(/\s+/g, ' ').trim();
      records.set(id, { nodeId: id, nodeName: linkText || id });
    });
    return [...records.values()];
  }

  function targetIds() {
    const ids = state.lockedTargetIds.length ? state.lockedTargetIds : selectedNodeIds();
    return ids.filter((nodeId) => nodeId !== state.template?.nodeId);
  }

  function findNodeId(element) {
    if (!element) return null;
    const values = [element.getAttribute?.('data-row-key'), element.getAttribute?.('data-node-id'), element.textContent];
    for (const value of values) {
      const nodeId = normalizeNodeId(value);
      if (nodeId) return nodeId;
    }
    for (const child of element.querySelectorAll?.('[data-row-key], [data-node-id], a[href], [title]') || []) {
      const nodeId = normalizeNodeId(child.getAttribute('data-row-key') || child.getAttribute('data-node-id') || child.getAttribute('href') || child.getAttribute('title') || child.textContent);
      if (nodeId) return nodeId;
    }
    return null;
  }

  function normalizeNodeId(value) {
    const match = String(value || '').match(NODE_ID_PATTERN);
    return match ? match[0].toLowerCase() : null;
  }

  async function mapConcurrent(items, concurrency, worker) {
    let index = 0;
    const results = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await worker(items[current]);
      }
    }));
    return results;
  }

  function writeAudit(type, data) {
    // Audit data is diagnostic only. It must never make a read-only precheck fail
    // when another extension or a previous version has exhausted localStorage.
    const entry = compactAuditValue({ at: new Date().toISOString(), type, ...data });
    const previous = Array.isArray(readJson(LOG_KEY)) ? readJson(LOG_KEY) : [];
    const records = [entry, ...previous.map((record) => compactAuditValue(record))];
    const bounded = boundAuditRecords(records);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(bounded));
    } catch (error) {
      // An old verbose log can itself prevent replacing the value. Clear it and
      // retain only the current compact record when the browser permits it.
      try {
        localStorage.removeItem(LOG_KEY);
        localStorage.setItem(LOG_KEY, JSON.stringify([entry]));
      } catch (fallbackError) {
        log('audit storage unavailable; continuing without persisted audit', fallbackError || error);
      }
    }
  }

  function boundAuditRecords(records) {
    const bounded = [];
    for (const record of records.slice(0, AUDIT_MAX_RECORDS)) {
      const next = [...bounded, record];
      if (JSON.stringify(next).length > AUDIT_MAX_CHARS) break;
      bounded.push(record);
    }
    return bounded.length ? bounded : records.slice(0, 1);
  }

  function compactAuditValue(value, depth = 0) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      return value.length > AUDIT_MAX_STRING_CHARS ? `${value.slice(0, AUDIT_MAX_STRING_CHARS)}...` : value;
    }
    if (value instanceof Error) return { name: value.name, message: message(value) };
    if (depth >= AUDIT_MAX_DEPTH) return '[truncated]';
    if (Array.isArray(value)) {
      const items = value.slice(0, AUDIT_MAX_ARRAY_ITEMS).map((item) => compactAuditValue(item, depth + 1));
      if (value.length > AUDIT_MAX_ARRAY_ITEMS) items.push(`[+${value.length - AUDIT_MAX_ARRAY_ITEMS} more]`);
      return items;
    }
    if (typeof value === 'object') {
      const result = {};
      const entries = Object.entries(value).slice(0, AUDIT_MAX_OBJECT_KEYS);
      entries.forEach(([key, item]) => { result[key] = compactAuditValue(item, depth + 1); });
      if (Object.keys(value).length > AUDIT_MAX_OBJECT_KEYS) result._truncatedKeys = Object.keys(value).length - AUDIT_MAX_OBJECT_KEYS;
      return result;
    }
    return String(value);
  }

  function briefTarget(item) {
    return { nodeId: item.nodeId, nodeName: item.nodeName, changed: item.diff.length, error: item.error || null };
  }

  function begin(notice) { state.running = true; state.notice = notice; render(); }
  function finish(notice) { state.running = false; state.notice = notice; render(); }
  function setNotice(notice) { state.notice = notice; render(); }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function copyConfigArgs(config, args) { return { ...clone(config || {}), args: String(args || '') }; }
  function compact(object) { return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)); }
  function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function shortId(id) { return String(id || '').slice(0, 8); }
  function message(error) { return String(error?.message || error || '未知错误').replace(/\s+/g, ' ').slice(0, 240); }
  function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function describeSchedules(schedules) {
    if (schedules === null) return '鍏ㄥぉ鏃堕棿璋冨害';
    if (!Array.isArray(schedules) || !schedules.length) return '未设置时段';
    return schedules.map((item) => `${toClock(item.scheduledStart)}-${toClock(item.scheduledEnd)}`).join(', ');
  }

  function describeNetworkType(value) {
    const type = String(value || '').trim();
    const labels = { public: '公网', private: '私网', full: '完全锥型 NAT', restricted: '受限锥型 NAT', symmetric: '对称型 NAT' };
    return labels[type] || type || '未设置';
  }
  function toClock(seconds) {
    const value = Number(seconds || 0);
    return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}`;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{position:relative;z-index:2147482605;display:inline-flex;align-items:center;align-self:stretch;margin-right:20px;font:13px/1.45 "Microsoft YaHei",sans-serif;color:#203047}
      #${ROOT_ID}[data-nlnfm-placement="fixed"]{position:fixed;top:12px;right:clamp(325px,21vw,470px);margin:0}
      .nlnfm-top-button{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 11px;border:1px solid #91d5ff;border-radius:5px;background:#f0f9ff;color:#0877b9;font:inherit;font-weight:700;cursor:pointer}.nlnfm-top-button:hover{border-color:#1890ff;background:#e6f7ff}.nlnfm-top-button b{padding:1px 6px;border-radius:10px;background:#d9f3ff;color:#0877b9;font-size:11px}.nlnfm-top-icon{font-size:18px;line-height:1}
      .nlnfm-mask{position:fixed;inset:0;z-index:2147482604;background:rgba(15,23,42,.32)}
      .nlnfm-workbench{position:fixed;z-index:2147482605;top:6vh;left:50%;width:min(1180px,calc(100vw - 44px));max-height:86vh;overflow:auto;transform:translateX(-50%);border:1px solid #d8e5f3;border-radius:11px;background:#fff;box-shadow:0 22px 70px rgba(15,23,42,.28)}
      .nlnfm-workbench-head{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 24px 17px;border-bottom:1px solid #e5edf5}.nlnfm-workbench-head strong{display:block;font-size:21px;line-height:30px;color:#1f2d3d}.nlnfm-workbench-head span{display:block;margin-top:3px;color:#6b7f99;font-size:14px}.nlnfm-close{border:0!important;background:transparent!important;color:#6b7f99!important;font-size:29px!important;line-height:1;cursor:pointer}
      .nlnfm-metrics{display:flex;align-items:center;gap:10px;padding:14px 24px;border-bottom:1px solid #e5edf5;background:#f8fbff}.nlnfm-chip{padding:7px 14px;border-radius:999px;background:#eef3f8;color:#61738c;font-size:14px;white-space:nowrap}.nlnfm-chip-blue{background:#e7f2ff;color:#1677ff}.nlnfm-chip-green{background:#e8faf0;color:#0ca678}.nlnfm-chip-warn{background:#fff4e6;color:#e67700}.nlnfm-metrics i{height:8px;flex:1;border-radius:99px;background:linear-gradient(90deg,#dbeafe,#e2e8f0)}.nlnfm-metrics em{color:#66788f;font-style:normal;white-space:nowrap}
      .nlnfm-body{display:grid;grid-template-columns:1.15fr .85fr;gap:16px;padding:21px 24px}.nlnfm-master-card,.nlnfm-config-card{min-width:0;padding:16px;border:1px solid #dce8f5;border-radius:9px;background:#fbfdff}.nlnfm-master-card{display:flex;align-items:center;justify-content:space-between;gap:16px}.nlnfm-master-card span,.nlnfm-section-label{display:block;color:#6b7f99;font-size:12px}.nlnfm-master-card strong{display:block;max-width:460px;overflow:hidden;color:#203047;font-size:15px;line-height:24px;text-overflow:ellipsis;white-space:nowrap}.nlnfm-master-card small{display:block;color:#91a1b5;font-size:12px}.nlnfm-actions{display:flex;gap:9px}.nlnfm-actions button{flex:1}.nlnfm-config-card p{margin:12px 0 0;color:#6b7f99}.nlnfm-config-card p b{color:#1677ff}.nlnfm-option-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.nlnfm-option-pills label{display:inline-flex;align-items:center;gap:5px;padding:7px 11px;border:1px solid #d6e3f0;border-radius:7px;background:#fff;color:#52657d;cursor:pointer}.nlnfm-option-pills label.nlnfm-selected{border-color:#91d5ff;background:#e6f7ff;color:#0877b9}.nlnfm-option-pills input{accent-color:#1890ff}.nlnfm-record-actions{margin-top:13px}.nlnfm-record-actions button:last-child{border-color:#1890ff;background:#e6f7ff;color:#0877b9}.nlnfm-scene-box{margin-top:14px;padding-top:13px;border-top:1px dashed #d6e3f0}.nlnfm-scene-input{box-sizing:border-box;width:100%;min-height:58px;margin-top:8px;padding:9px 10px;border:1px solid #cbd9e7;border-radius:7px;background:#fff;color:#203047;font:13px/1.45 "Microsoft YaHei",sans-serif;resize:vertical;outline:none}.nlnfm-scene-input:focus{border-color:#40a9ff;box-shadow:0 0 0 2px rgba(24,144,255,.12)}.nlnfm-default-business-table{width:100%;margin-top:8px;border-collapse:separate;border-spacing:0}.nlnfm-default-business-table th,.nlnfm-default-business-table td{padding:6px 0;vertical-align:middle}.nlnfm-default-business-table th{color:#6b7f99;font-size:12px;font-weight:600;text-align:left}.nlnfm-default-business-table th:last-child,.nlnfm-default-business-table td:last-child{text-align:right}.nlnfm-default-business-table tbody tr+tr td{border-top:1px solid #edf2f7}.nlnfm-default-business-table input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:1px solid #cbd9e7;border-radius:6px;background:#fff;color:#203047;font:13px/1.45 "Microsoft YaHei",sans-serif;outline:none}.nlnfm-default-business-table input:focus{border-color:#40a9ff;box-shadow:0 0 0 2px rgba(24,144,255,.12)}.nlnfm-default-business-table td:first-child,.nlnfm-default-business-table td:nth-child(2){padding-right:8px}.nlnfm-default-business-remove{min-width:34px!important;padding:0 10px!important;border-color:#d6e3f0!important;background:#fff!important;color:#7c8ea5!important}.nlnfm-default-business-empty{padding:8px 0;color:#91a1b5}.nlnfm-scene-summary{min-height:18px;margin:8px 0 0!important;padding:7px 9px;border-radius:7px;background:#f0f9ff;color:#075985!important;white-space:pre-line}
      .nlnfm-workbench-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 24px;border-top:1px solid #e5edf5;background:#f8fbff}.nlnfm-status-wrap{display:flex;min-width:0;flex:1;align-items:center;gap:10px;flex-wrap:wrap}.nlnfm-status{min-height:19px;color:#1677ff}.nlnfm-failure-actions{display:flex;gap:7px}.nlnfm-failure-actions button{min-height:28px!important;padding:3px 9px!important;border-color:#fecdd3!important;background:#fff1f2!important;color:#be123c!important;font-size:12px!important}.nlnfm-primary button:first-child{border-color:#91d5ff;background:#fff;color:#0877b9}.nlnfm-primary button:last-child{border-color:#1890ff;background:#1890ff;color:#fff}#${ROOT_ID} button{min-height:34px;padding:5px 11px;border:1px solid #cbd9e7;border-radius:6px;background:#fff;color:#40546d;font:inherit;cursor:pointer}#${ROOT_ID} button:disabled{opacity:.45;cursor:not-allowed}.nlnfm-workbench details{margin:0 24px 18px;color:#70839a}.nlnfm-workbench details p{margin:7px 0 0;font-size:12px}
      .nlnfm-special-actions{display:flex;align-items:center;gap:9px;margin:0 24px 14px}.nlnfm-special-actions span{margin-right:3px;color:#6b7f99;font-size:12px}.nlnfm-special-actions button:first-of-type{border-color:#d3adf7!important;background:#f9f0ff!important;color:#722ed1!important}.nlnfm-special-actions button:last-of-type{border-color:#ffd591!important;background:#fff7e6!important;color:#d46b08!important}
      #nlnfm-preview{position:fixed;z-index:2147482607;top:14vh;left:50%;width:min(930px,calc(100vw - 54px));max-height:62vh;overflow:auto;transform:translateX(-50%);padding:17px;border:1px solid #bfdbfe;border-radius:10px;background:#fff;box-shadow:0 20px 58px rgba(15,23,42,.30);font:13px/1.45 "Microsoft YaHei",sans-serif;color:#203047}
      .nlnfm-dialog-head{display:flex;justify-content:space-between;align-items:center;font-size:16px}.nlnfm-table{overflow:auto;max-height:28vh;border:1px solid #e2e8f0;border-radius:7px}.nlnfm-table table{width:100%;border-collapse:collapse}.nlnfm-table th,.nlnfm-table td{padding:7px 8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}.nlnfm-table th{position:sticky;top:0;background:#f8fafc}.nlnfm-change{background:#fff7ed}.nlnfm-error{background:#fff1f2;color:#be123c}#nlnfm-preview footer{margin-top:8px;color:#0369a1}
      .nlnfm-plan-list{display:flex;flex-direction:column;gap:8px;max-height:52vh;overflow:auto;margin-top:10px}.nlnfm-plan-row{display:grid;grid-template-columns:minmax(320px,1.22fr) minmax(210px,.86fr) minmax(180px,.72fr) minmax(170px,.68fr) minmax(200px,.78fr) minmax(180px,.72fr);gap:12px;padding:11px 12px;border:1px solid #e2e8f0;border-radius:9px;background:#fff}.nlnfm-plan-bad{border-color:#fecdd3;background:#fff1f2}.nlnfm-plan-ok{border-color:#bae6fd;background:#f0f9ff}.nlnfm-plan-node span,.nlnfm-plan-result span,.nlnfm-plan-meta span{display:block;margin-bottom:4px;color:#64748b;font-size:12px}.nlnfm-plan-result strong,.nlnfm-plan-meta strong{display:block;font-size:15px;line-height:1.35;overflow-wrap:anywhere}.nlnfm-plan-result small{display:block;margin-top:3px;line-height:1.45}.nlnfm-plan-meta strong{color:#203047}
      #nlnfm-master-picker{position:fixed;z-index:2147482608;top:18vh;left:50%;width:min(620px,calc(100vw - 44px));transform:translateX(-50%);padding:18px;border:1px solid #bfdbfe;border-radius:10px;background:#fff;box-shadow:0 20px 58px rgba(15,23,42,.32);font:13px/1.45 "Microsoft YaHei",sans-serif;color:#203047}#nlnfm-master-picker p{color:#64748b}.nlnfm-master-list{max-height:42vh;overflow:auto;border:1px solid #e2e8f0;border-radius:7px}.nlnfm-master-list label{display:grid;grid-template-columns:22px minmax(0,1fr) 235px;gap:8px;align-items:center;padding:10px;border-bottom:1px solid #e2e8f0;cursor:pointer}.nlnfm-master-list label:hover{background:#f0f9ff}.nlnfm-master-list label:last-child{border-bottom:0}.nlnfm-master-list span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#075985}.nlnfm-master-list code{overflow:hidden;color:#64748b;text-overflow:ellipsis;white-space:nowrap}#nlnfm-master-picker footer{display:flex;justify-content:flex-end;gap:8px;margin-top:13px}#nlnfm-master-picker button{min-height:32px;padding:5px 11px;border:1px solid #cbd9e7;border-radius:6px;background:#fff;color:#40546d;font:inherit;cursor:pointer}.nlnfm-picker-confirm{border-color:#1890ff!important;background:#1890ff!important;color:#fff!important}
      #nlnfm-action-dialog,#nlnfm-failure-dialog{position:fixed;z-index:2147482609;top:8vh;left:50%;width:min(1120px,calc(100vw - 16px));max-height:88vh;overflow:auto;transform:translateX(-50%);padding:18px;border:1px solid #bfdbfe;border-radius:10px;background:#fff;box-shadow:0 20px 58px rgba(15,23,42,.32);font:13px/1.45 "Microsoft YaHei",sans-serif;color:#203047}#nlnfm-action-dialog p,#nlnfm-failure-dialog p{margin:11px 0;color:#53657c}#nlnfm-action-dialog b,#nlnfm-failure-dialog b{color:#1677ff}#nlnfm-action-dialog footer,#nlnfm-failure-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}#nlnfm-action-dialog button,#nlnfm-failure-dialog button{min-height:32px;padding:5px 11px;border:1px solid #cbd9e7;border-radius:6px;background:#fff;color:#40546d;font:inherit;cursor:pointer}#nlnfm-action-dialog button:disabled,#nlnfm-failure-dialog button:disabled{opacity:.48;cursor:not-allowed}.nlnfm-dialog-hint{font-size:12px;color:#6b7f99!important}.nlnfm-demand-toolbar{display:flex;align-items:center;gap:10px;margin:13px 0 8px}.nlnfm-demand-toolbar button{border-color:#91d5ff!important;background:#f0f9ff!important;color:#0877b9!important}.nlnfm-demand-toolbar span{color:#6b7f99}.nlnfm-demand-reuse{display:flex;align-items:center;gap:6px;margin:8px 0;color:#34506f;font-weight:600;cursor:pointer}.nlnfm-demand-reuse input{width:16px;height:16px;accent-color:#1677ff}.nlnfm-demand-reuse-hint{margin-top:0!important}.nlnfm-demand-reuse-hint code{padding:1px 4px;border-radius:3px;background:#edf5ff;color:#075985}.nlnfm-demand-hint-detail{margin:8px 0 10px;border:1px solid #dbeafe;border-radius:8px;background:#f8fbff}.nlnfm-demand-hint-detail summary{padding:8px 10px;color:#1677ff;cursor:pointer}.nlnfm-demand-hint-detail p{margin:0;padding:0 10px 10px;color:#6b7f99}.nlnfm-demand-results{max-height:34vh;overflow:auto;border:1px solid #e2e8f0;border-radius:7px;background:#fbfdff}.nlnfm-demand-results>p{padding:9px 11px}.nlnfm-demand-row{display:grid;grid-template-columns:92px minmax(0,1fr) 74px;gap:9px;align-items:center;padding:9px 11px;border-bottom:1px solid #e2e8f0}.nlnfm-demand-row:last-child{border-bottom:0}.nlnfm-demand-row strong{font-family:Consolas,monospace;color:#075985}.nlnfm-demand-row select{min-width:0;width:100%;height:32px;padding:0 7px;border:1px solid #cbd9e7;border-radius:6px;background:#fff;color:#203047}.nlnfm-demand-row span{color:#6b7f99;font-size:12px;text-align:right}.nlnfm-demand-row details{grid-column:1 / -1;margin-top:2px}.nlnfm-demand-row details summary{color:#1677ff;cursor:pointer;font-size:12px}.nlnfm-demand-row details p{margin:6px 0 0;color:#64748b;font-size:12px}.nlnfm-demand-error{color:#be123c!important}.nlnfm-table{max-height:52vh;overflow:auto}.nlnfm-node-id-wrap{display:flex;align-items:center;gap:8px;min-width:0}.nlnfm-node-id-wrap code{max-width:none;overflow:visible;white-space:normal;overflow-wrap:anywhere;word-break:break-all}.nlnfm-node-id-wrap button{flex:0 0 auto;min-height:26px;padding:2px 8px;border-color:#d6e3f0!important;background:#f8fbff!important;color:#1677ff!important;font-size:12px}.nlnfm-preview-ok strong{color:#0f766e}.nlnfm-preview-ok small{color:#0f766e}.nlnfm-preview-bad strong{color:#be123c}.nlnfm-preview-bad small{color:#9f1239}.nlnfm-id-summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 10px!important;padding:8px 10px;border:1px solid #dbeafe;border-radius:8px;background:#f8fbff}.nlnfm-id-summary strong{color:#334155;min-width:90px}.nlnfm-id-summary span{min-width:18px;padding:1px 6px;border-radius:999px;background:#e8f2ff;color:#1677ff;font-weight:700;text-align:center}.nlnfm-id-summary button{min-height:26px;padding:2px 8px;border-color:#d6e3f0!important;background:#fff!important;color:#1677ff!important;font-size:12px}.nlnfm-preview-detail{margin:8px 0 10px;border:1px solid #dbeafe;border-radius:8px;background:#f8fbff}.nlnfm-preview-detail summary{padding:8px 10px;color:#1677ff;cursor:pointer}.nlnfm-preview-detail p{margin:0;padding:0 10px 10px;color:#6b7f99}
      .nlnfm-business-picker{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:13px}.nlnfm-business-picker>section{min-width:0;padding:12px;border:1px solid #dce8f5;border-radius:9px;background:#f8fbff}.nlnfm-business-picker header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.nlnfm-business-picker header strong{color:#203047}.nlnfm-business-picker header span{color:#1677ff;font-size:12px}.nlnfm-business-filter{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:1px solid #cbd9e7;border-radius:6px;background:#fff;color:#203047;font:inherit;outline:none}.nlnfm-business-filter:focus{border-color:#40a9ff;box-shadow:0 0 0 2px rgba(24,144,255,.12)}.nlnfm-business-list{max-height:250px;overflow:auto;margin-top:8px;border:1px solid #e2e8f0;border-radius:7px;background:#fff}.nlnfm-business-list label{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:7px;align-items:center;padding:8px 9px;border-bottom:1px solid #edf2f7;cursor:pointer}.nlnfm-business-list label:last-child{border-bottom:0}.nlnfm-business-list label:hover{background:#f0f9ff}.nlnfm-business-list label[data-rule-hidden="yes"]{display:none}.nlnfm-business-list input{accent-color:#1890ff}.nlnfm-business-list span{overflow:hidden;color:#334155;text-overflow:ellipsis;white-space:nowrap}.nlnfm-business-list code{color:#8291a5;font-size:11px}.nlnfm-business-list em{grid-column:2/4;color:#0f8a5f;font-size:11px;font-style:normal}.nlnfm-business-list em.nlnfm-rule-default{color:#1677ff;font-weight:700}.nlnfm-business-empty{padding:9px!important;color:#91a1b5!important}.nlnfm-business-selection{min-height:18px;padding:8px 10px;border-radius:6px;background:#f0f9ff;color:#075985!important}.nlnfm-virtual-rule-hint{margin-bottom:5px!important;color:#0f766e!important}
      @media(max-width:800px){#${ROOT_ID}[data-nlnfm-placement="fixed"]{top:10px;right:154px}.nlnfm-top-button b{display:none}.nlnfm-workbench{top:2vh;width:calc(100vw - 20px);max-height:94vh}.nlnfm-body,.nlnfm-business-picker{grid-template-columns:1fr}.nlnfm-body{padding:14px}.nlnfm-master-card{align-items:flex-start;flex-direction:column}.nlnfm-workbench-foot{align-items:stretch;flex-direction:column;padding:14px}.nlnfm-metrics{overflow:auto;padding:11px}.nlnfm-metrics i,.nlnfm-metrics em{display:none}}
    `;
    document.head.appendChild(style);
  }
})();




