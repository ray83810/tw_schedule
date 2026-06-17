/**
 * Asurion Roster - 客服人員排班自動化工具
 * 核心邏輯、勞基法合規檢查器與 CSP 智能排班演算法
 */

// 1. 全域狀態管理器 (State)
const state = {
  currentYear: 2026,
  currentMonth: 4, // 0-indexed, 4 = 五月
  daysOff: 8,      // 每人每月固定休假天數
  staff: [],       // 客服人員名單
  shifts: [],      // 班次定義
  coverageTargets: {}, // 各班次每日最少人數需求 { shiftId: { weekday: N, weekend: N } }
  roster: {},      // 已發布班表 { 'YYYY-MM-DD': { staffId: shiftId } }
  theme: 'dark',   // 'dark' or 'light'
  hasUnsavedChanges: false, // 標記當前是否有未儲存的變更
  googleWebAppUrl: 'https://script.google.com/macros/s/AKfycbzv05O95bIipY0MqRX-9gyP-VCP9GRfvAHLpSorDZNdvIGzmolQYPEvGFus7y5UDPfV/exec',      // Google Sheets Apps Script Web App 網址
  backupRoster: {},          // 保存上次儲存的班表備份以供「取消變更」復原
  manualEdits: {},            // 追蹤手動編輯的格子 { 'YYYY-MM-DD_staffId': true }
  monthlyDaysOff: {}         // 追蹤每個月自訂的休假天數 { 'YYYY-MM': number }
};

let dragSrcEl = null;

// 歷史操作記錄 (復原/重做 Undo/Redo 棧)
let undoStack = [];
let redoStack = [];

// 2. 預設測試資料 (Initial Seeds)
const DEFAULT_STAFF = [
  {
    id: 'staff_1',
    name: 'Alex Chen',
    pto: ['2026-05-01', '2026-05-15'],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'A',
    sortIndex: 0
  },
  {
    id: 'staff_3',
    name: 'Amber Wang',
    pto: ['2026-05-02', '2026-05-03'],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'A',
    sortIndex: 1
  },
  {
    id: 'staff_6',
    name: 'Jian Kai Ding',
    pto: ['2026-05-28'],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'A',
    sortIndex: 2
  },
  {
    id: 'staff_8',
    name: 'Sherry Lin',
    pto: [],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'A',
    sortIndex: 3
  },
  {
    id: 'staff_2',
    name: 'Howard Chen',
    pto: ['2026-05-10'],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'B',
    sortIndex: 4
  },
  {
    id: 'staff_5',
    name: 'Evan Liu',
    pto: ['2026-05-20'],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'B',
    sortIndex: 5
  },
  {
    id: 'staff_4',
    name: 'Jacky Lee',
    pto: [],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'C',
    sortIndex: 6
  },
  {
    id: 'staff_7',
    name: 'Rex Liao',
    pto: [],
    defaultOffDays: [0, 6],
    defaultWorkShift: 'C',
    sortIndex: 7
  },
  {
    id: 'staff_9',
    name: 'Molly Song',
    pto: [],
    defaultOffDays: [1, 2],
    defaultWorkShift: 'D',
    sortIndex: 8
  }
];

const DEFAULT_SHIFTS = [
  { id: 'A', name: '早班', start: '08:00', end: '17:00', type: 'system', colorClass: 'shift-A' },
  { id: 'B', name: '中班', start: '11:00', end: '20:00', type: 'system', colorClass: 'shift-B' },
  { id: 'C', name: '晚班', start: '15:00', end: '00:00', type: 'system', colorClass: 'shift-C' },
  { id: 'D', name: '獨立班', start: '12:00', end: '21:00', type: 'system', colorClass: 'custom' }
];

const DEFAULT_COVERAGE = {
  A: { weekday: 2, weekend: 1 },
  B: { weekday: 1, weekend: 1 },
  C: { weekday: 1, weekend: 1 },
  D: { weekday: 0, weekend: 0 }
};

// 3. 初始化儲存與加載 (Storage Utils)
function initDatabase() {
  // 優先加載 localStorage
  const savedState = localStorage.getItem('aura_roster_state');
  if (savedState) {
    try {
      const parsed = JSON.parse(savedState);
      state.currentYear = parsed.currentYear || 2026;
      state.currentMonth = parsed.currentMonth !== undefined ? parsed.currentMonth : 4;
      state.daysOff = parsed.daysOff || 8;
      state.monthlyDaysOff = parsed.monthlyDaysOff || {};
      state.staff = parsed.staff || [];

      // 自動升級檢測：若舊快取名單中沒有 defaultOffDays 欄位，自動升級為預設星期六、日休假
      state.staff.forEach((emp, idx) => {
        if (!emp.defaultOffDays) {
          emp.defaultOffDays = [0, 6];
        }
        delete emp.isIndependent;
        delete emp.qaScore;
        delete emp.techAcw;
        delete emp.techAht;
        delete emp.tempSupport;
        
        // 自動升級：若舊快取沒有 sortIndex，依當前陣列順序自動指派
        if (emp.sortIndex === undefined || emp.sortIndex === null) {
          emp.sortIndex = idx;
        }
      });

      // 自動升級檢測：若舊快取名單中沒有 defaultWorkShift 欄位，自動升級為預設班別
      state.staff.forEach(emp => {
        if (!emp.defaultWorkShift) {
          if (emp.name === 'Alex Chen' || emp.name === 'Amber Wang' || emp.name === 'Jian Kai Ding' || emp.name === 'Sherry Lin') {
            emp.defaultWorkShift = 'A';
          } else if (emp.name === 'Howard Chen' || emp.name === 'Evan Liu') {
            emp.defaultWorkShift = 'B';
          } else if (emp.name === 'Jacky Lee' || emp.name === 'Rex Liao') {
            emp.defaultWorkShift = 'C';
          } else {
            emp.defaultWorkShift = 'A';
          }
        }
      });

      state.shifts = parsed.shifts || [];
      state.coverageTargets = parsed.coverageTargets || {};
      state.roster = parsed.roster || {};
      state.theme = parsed.theme || 'dark';
      state.googleWebAppUrl = parsed.googleWebAppUrl || 'https://script.google.com/macros/s/AKfycbzv05O95bIipY0MqRX-9gyP-VCP9GRfvAHLpSorDZNdvIGzmolQYPEvGFus7y5UDPfV/exec';

      state.backupRoster = JSON.parse(JSON.stringify(state.roster));
      state.backupStaff = JSON.parse(JSON.stringify(state.staff));
      state.manualEdits = {};
      state.hasUnsavedChanges = false;

      // 自動升級檢測：如果快取名單長度小於 9 位或是沒有 Molly Song，直接重置並載入最新 9 人名單
      const hasMolly = state.staff.some(emp => emp.name === 'Molly Song');
      if (state.staff.length < 9 || !hasMolly) {
        console.log("偵測到舊版快取名單，自動重置為最新預設 9 人名單...");
        loadDefaults();
      }
    } catch (e) {
      console.error("解析 LocalStorage 失敗，重置為預設值", e);
      loadDefaults();
    }
  } else {
    loadDefaults();
  }
  
  applyTheme(state.theme);
  sortStaffByShift();
  rebuildSortedStaffIds();
}

function loadDefaults() {
  state.currentYear = 2026;
  state.currentMonth = 4; // 五月
  state.monthlyDaysOff = {};
  updateDaysOffFromState();
  state.staff = JSON.parse(JSON.stringify(DEFAULT_STAFF));
  sortStaffByShift();
  state.shifts = JSON.parse(JSON.stringify(DEFAULT_SHIFTS));
  state.coverageTargets = JSON.parse(JSON.stringify(DEFAULT_COVERAGE));
  state.roster = {}; // 預設空班表
  state.googleWebAppUrl = 'https://script.google.com/macros/s/AKfycbzv05O95bIipY0MqRX-9gyP-VCP9GRfvAHLpSorDZNdvIGzmolQYPEvGFus7y5UDPfV/exec';
  state.backupRoster = {};
  state.backupStaff = JSON.parse(JSON.stringify(state.staff));
  state.manualEdits = {};
  state.hasUnsavedChanges = false;
  saveToLocalStorage();
  rebuildSortedStaffIds();
}

function saveToLocalStorage() {
  localStorage.setItem('aura_roster_state', JSON.stringify(state));
}

// 切換主題
function applyTheme(theme) {
  state.theme = theme;
  if (theme === 'light') {
    document.body.classList.remove('dark-theme');
    document.body.classList.add('light-theme');
  } else {
    document.body.classList.remove('light-theme');
    document.body.classList.add('dark-theme');
  }
}

// 4. 時間輔助函數 (Date Helpers)
function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function getDayOfWeek(year, month, day) {
  return new Date(year, month, day).getDay(); // 0 = 週日, 6 = 週六
}

function getDayOfWeekName(dayOfWeek) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  return names[dayOfWeek];
}

function formatDateISO(year, month, day) {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// 取得特定年月之預設休假天數（2026 年套用指定值，其他年份預設為 8 天）
function getDefaultDaysOff(year, month) {
  if (year === 2026) {
    const defaults = {
      0: 11, // 1月
      1: 11, // 2月
      2: 11, // 3月
      3: 10, // 4月
      4: 10, // 5月
      5: 10, // 6月
      6: 9,  // 7月
      7: 9,  // 8月
      8: 10, // 9月
      9: 10, // 10月
      10: 10,// 11月
      11: 9  // 12月
    };
    return defaults[month] !== undefined ? defaults[month] : 8;
  }
  return 8;
}

// 依據目前狀態年月更新休假天數（若有手動設定則套用手動值，否則帶入預設值）
function updateDaysOffFromState() {
  const key = `${state.currentYear}-${state.currentMonth}`;
  if (state.monthlyDaysOff && state.monthlyDaysOff[key] !== undefined) {
    state.daysOff = state.monthlyDaysOff[key];
  } else {
    state.daysOff = getDefaultDaysOff(state.currentYear, state.currentMonth);
  }
  
  const daysOffInput = document.getElementById('global-days-off');
  if (daysOffInput) {
    daysOffInput.value = state.daysOff;
  }
}

// 取得針對「班表總覽」排序後的客服人員陣列 (不更動 state.staff 原始順序)
// 排序規則：班別優先級 (A > B > C > D...) -> 預設休假天分組優先級 (日一 > 三四 > 五六 > 其它) -> 姓名 A-Z 穩定排序
function getSortedStaffForOverview(staffList) {
  const shiftPriority = {};
  if (state.shifts) {
    state.shifts.forEach((s, idx) => { shiftPriority[s.id] = idx; });
  }
  
  return [...staffList].sort((a, b) => {
    // 1. 班別優先級
    const pa = shiftPriority[a.defaultWorkShift] ?? 999;
    const pb = shiftPriority[b.defaultWorkShift] ?? 999;
    if (pa !== pb) return pa - pb;
    
    // 2. 預設休假天分組優先級 (日一 > 三四 > 五六 > 其它)
    const getOffDaysPriority = (defaultOffDays) => {
      if (!defaultOffDays || !Array.isArray(defaultOffDays)) return 4;
      const has = (day) => defaultOffDays.includes(day);
      if (has(0) && has(1)) return 1; // 休週日週一
      if (has(3) && has(4)) return 2; // 休週三週四
      if (has(5) && has(6)) return 3; // 休週五週六
      return 4;
    };
    
    const pua = getOffDaysPriority(a.defaultOffDays);
    const pub = getOffDaysPriority(b.defaultOffDays);
    if (pua !== pub) return pua - pub;
    
    // 3. 姓名 A-Z
    return a.name.localeCompare(b.name);
  });
}

// 取得指定休假日在當前月份的假別 (OFF 或 PTO)
function getLeaveTypeForPtoDay(emp, dateStr, customPtoList = null) {
  const day = new Date(dateStr);
  const year = day.getFullYear();
  const month = day.getMonth(); // 0-indexed
  
  // 1. 如果與固定休假日撞到，一定是 OFF
  const dayOfWeek = day.getDay(); // 0=Sun, 6=Sat
  const isDefaultOff = emp.defaultOffDays && emp.defaultOffDays.includes(dayOfWeek);
  if (isDefaultOff) return 'OFF';
  
  // 2. 計算當月固定休假天數 D
  const daysCount = getDaysInMonth(year, month);
  let defaultOffDaysCount = 0;
  for (let d = 1; d <= daysCount; d++) {
    const dow = getDayOfWeek(year, month, d);
    if (emp.defaultOffDays && emp.defaultOffDays.includes(dow)) {
      defaultOffDaysCount++;
    }
  }
  
  // 3. 計算多餘休假日 S
  const surplus = Math.max(0, state.daysOff - defaultOffDaysCount);
  
  // 4. 篩選出所有「非固定休假日」的已選日期，並按日期排序
  const listToUse = customPtoList || emp.pto || [];
  const nonDefaultPtoDays = listToUse
    .filter(d => {
      const ptoDow = new Date(d).getDay();
      return !(emp.defaultOffDays && emp.defaultOffDays.includes(ptoDow));
    })
    .sort();
  
  // 5. 比較當前 dateStr 索引與多餘額度
  const idx = nonDefaultPtoDays.indexOf(dateStr);
  if (idx !== -1 && idx < surplus) {
    return 'OFF';
  }
  return 'PTO';
}

// 檢查特定員工是否滿足「兩天固定休假日中至少有一天整個月完全不被動到」的規定
function isEmployeeDefaultOffDaysConstraintCompliant(roster, empId, year, month) {
  const emp = state.staff.find(e => e.id === empId);
  if (!emp || !emp.defaultOffDays || emp.defaultOffDays.length !== 2) return true;
  
  const d1 = emp.defaultOffDays[0];
  const d2 = emp.defaultOffDays[1];
  const daysCount = getDaysInMonth(year, month);
  
  let workedOnD1 = false;
  let workedOnD2 = false;
  
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(year, month, d);
    const dayOfWeek = getDayOfWeek(year, month, d);
    
    // 檢查該員本日是否排班 (非 OFF/PTO/LOA/AM_PTO/PM_PTO)
    const shiftId = roster[dateStr] ? roster[dateStr][empId] : 'OFF';
    const isWorking = (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA' && shiftId !== 'AM_PTO' && shiftId !== 'PM_PTO');
    
    if (isWorking) {
      if (dayOfWeek === d1) workedOnD1 = true;
      if (dayOfWeek === d2) workedOnD2 = true;
    }
  }
  
  // 不能兩天都被動到
  return !(workedOnD1 && workedOnD2);
}

// 計算兩班別之間的休息間隔 (小時)
function calculateRestHours(prevShift, nextShift) {
  if (!prevShift || prevShift.id === 'OFF' || prevShift.id === 'PTO') return 24;
  if (!nextShift || nextShift.id === 'OFF' || nextShift.id === 'PTO') return 24;

  const parseTimeToHours = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h + m / 60;
  };

  const prevStart = parseTimeToHours(prevShift.start);
  let prevEnd = parseTimeToHours(prevShift.end);
  const nextStart = parseTimeToHours(nextShift.start);

  // 處理跨日班別 (例如 23:00 - 08:00)
  if (prevEnd <= prevStart) {
    prevEnd += 24; 
  }

  // 隔天的上班時間相對於前一天開始是 24 + nextStart
  const rest = (24 + nextStart) - prevEnd;
  return rest;
}

// 4.9 智慧跨月邊界分析器 (Cross-Month Boundary Analyzer)
function getPreviousMonthBoundaryStats(empId, year, month) {
  let prevYear = year;
  let prevMonth = month - 1;
  if (month === 0) {
    prevYear = year - 1;
    prevMonth = 11;
  }
  
  const prevDaysCount = getDaysInMonth(prevYear, prevMonth);
  let lastShiftId = null;
  let consecutiveWork = 0;
  
  // 1. 取得前一個月最後一天的班別
  const lastDayDateStr = formatDateISO(prevYear, prevMonth, prevDaysCount);
  if (state.roster && state.roster[lastDayDateStr] && state.roster[lastDayDateStr][empId]) {
    lastShiftId = state.roster[lastDayDateStr][empId];
  }
  
  // 2. 往回追溯計算連續上班天數
  for (let d = prevDaysCount; d >= 1; d--) {
    const dateStr = formatDateISO(prevYear, prevMonth, d);
    const shiftId = (state.roster && state.roster[dateStr] && state.roster[dateStr][empId]) || 'OFF';
    
    const isWork = (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA');
    if (isWork) {
      consecutiveWork++;
    } else {
      break; // 遇到休假就中斷
    }
  }
  
  return { lastShiftId, consecutiveWork };
}

// 4.5. 穩定排班列排序管理器 (Stable Row Sorting Manager)
function sortStaffByShift() {
  // 依 sortIndex 穩定排序，保留使用者的自訂拖曳順序
  state.staff.sort((emp1, emp2) => {
    const s1 = (emp1.sortIndex !== undefined && emp1.sortIndex !== null) ? emp1.sortIndex : 999;
    const s2 = (emp2.sortIndex !== undefined && emp2.sortIndex !== null) ? emp2.sortIndex : 999;
    return s1 - s2;
  });
}

function rebuildSortedStaffIds() {
  state.sortedStaffIds = state.staff.map(emp => emp.id);
}

// 5. 勞基法與排班規則即時稽核器 (Labor Law Auditor)
function auditRoster(year, month) {
  const warnings = [];
  const daysCount = getDaysInMonth(year, month);
  const staffMap = new Map(state.staff.map(s => [s.id, s]));
  const shiftMap = new Map(state.shifts.map(s => [s.id, s]));
  
  // 建立額外虛擬班別代表休假與特殊假別
  shiftMap.set('OFF', { id: 'OFF', name: '休假', start: '00:00', end: '00:00' });
  shiftMap.set('PTO', { id: 'PTO', name: '特休', start: '00:00', end: '00:00' });
  shiftMap.set('LOA', { id: 'LOA', name: '體檢', start: '00:00', end: '00:00' });
  shiftMap.set('AM_PTO', { id: 'AM_PTO', name: '上午特休', start: '00:00', end: '00:00' });
  shiftMap.set('PM_PTO', { id: 'PM_PTO', name: '下午特休', start: '00:00', end: '00:00' });

  // 一、針對每位客服人員的個人檢查 (7休1、11小時輪班間隔、每月休天數)
  state.staff.forEach(employee => {
    // 智慧跨月邊界歷史追溯檢查
    const boundary = getPreviousMonthBoundaryStats(employee.id, year, month);
    let consecutiveWorkDays = boundary.consecutiveWork;
    let regularOffDays = 0;
    let prevShiftId = boundary.lastShiftId;

    for (let day = 1; day <= daysCount; day++) {
      const dateStr = formatDateISO(year, month, day);
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][employee.id]) || 'OFF';

      const isWork = (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA');

      // 1. 7休1原則 (連續上班不能超過 6 天)
      if (isWork) {
        consecutiveWorkDays++;
        if (consecutiveWorkDays > 6) {
          warnings.push({
            type: 'labor_7_1',
            severity: 'error',
            employeeId: employee.id,
            employeeName: employee.name,
            date: dateStr,
            message: `${employee.name} 自此日前已連續上班 ${consecutiveWorkDays} 天，違反勞基法「7休1」(不得連續工作超過6天)規定。`
          });
        }
      } else {
        consecutiveWorkDays = 0;
      }

      if (shiftId === 'OFF') {
        regularOffDays++;
      }

      // 2. 11小時輪班間隔檢查 (與前一天對比)
      if (prevShiftId && shiftId) {
        const prevShift = shiftMap.get(prevShiftId);
        const currShift = shiftMap.get(shiftId);

        const leaveTypes = ['OFF', 'PTO', 'LOA', 'AM_PTO', 'PM_PTO'];
        if (prevShift && currShift && !leaveTypes.includes(prevShiftId) && !leaveTypes.includes(shiftId)) {
          const restHours = calculateRestHours(prevShift, currShift);
          if (restHours < 11) {
            const dayLabel = day === 1 ? '上月底' : `${day - 1}日`;
            warnings.push({
              type: 'labor_rest_11',
              severity: 'error',
              employeeId: employee.id,
              employeeName: employee.name,
              date: dateStr,
              message: `${employee.name} 於 ${dayLabel}排「${prevShift.name}」(${prevShift.start}-${prevShift.end})，本日排「${currShift.name}」(${currShift.start}-${currShift.end})，輪班休息間隔僅 ${restHours.toFixed(1)} 小時，違反勞基法規定的「輪班間隔至少11小時」！`
            });
          }
        }
      }

      // 3. 指定休假日工作衝突確認 (是否有排定指定休假日卻被排上班的情況)
      const leaveTypes = ['OFF', 'PTO', 'LOA', 'AM_PTO', 'PM_PTO'];
      if (employee.pto.includes(dateStr) && !leaveTypes.includes(shiftId)) {
        warnings.push({
          type: 'pto_conflict',
          severity: 'error',
          employeeId: employee.id,
          employeeName: employee.name,
          date: dateStr,
          message: `${employee.name} 於本日已設定為指定休假日，卻被指派了「${shiftMap.get(shiftId)?.name || shiftId}」，請予以排休！`
        });
      }

      prevShiftId = shiftId;
    }

    // 4. 每月固定休假天數驗證
    if (regularOffDays < state.daysOff) {
      warnings.push({
        type: 'off_days_short',
        severity: 'warning',
        employeeId: employee.id,
        employeeName: employee.name,
        message: `${employee.name} 本月排定一般休假共 ${regularOffDays} 天，少於設定的固定休假天數 ${state.daysOff} 天（相差 ${state.daysOff - regularOffDays} 天）。`
      });
    }
    
    // 5. 兩天固定休假日中至少有一天整個月完全不被動到
    if (employee.defaultOffDays && employee.defaultOffDays.length === 2) {
      if (!isEmployeeDefaultOffDaysConstraintCompliant(state.roster, employee.id, year, month)) {
        const d1 = employee.defaultOffDays[0];
        const d2 = employee.defaultOffDays[1];
        warnings.push({
          type: 'default_off_conflict',
          severity: 'error',
          employeeId: employee.id,
          employeeName: employee.name,
          message: `${employee.name} 的固定休假日 (週${getDayOfWeekName(d1)}、週${getDayOfWeekName(d2)}) 本月皆有調班排班記錄。依規定，兩天固定休假日中必須至少有一種整個月完全不被動到。`
        });
      }
    }
  });

  // 二、針對每日班次覆蓋率的檢查 (人力覆蓋率)
  for (let day = 1; day <= daysCount; day++) {
    const dateStr = formatDateISO(year, month, day);
    const dayOfWeek = getDayOfWeek(year, month, day);
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    // 計算當日各班次被指派的人數
    const counts = {};
    state.shifts.forEach(s => counts[s.id] = 0);

    state.staff.forEach(employee => {
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][employee.id]) || 'OFF';
      if (counts[shiftId] !== undefined) {
        counts[shiftId]++;
      }
    });

    // 比對需求 targets
    state.shifts.forEach(shift => {
      const targetConfig = state.coverageTargets[shift.id] || { weekday: 0, weekend: 0 };
      const required = isWeekend ? targetConfig.weekend : targetConfig.weekday;
      const scheduled = counts[shift.id];

      if (scheduled < required) {
        warnings.push({
          type: 'coverage_shortage',
          severity: 'warning',
          date: dateStr,
          shiftId: shift.id,
          message: `${dateStr} (${getDayOfWeekName(dayOfWeek)}) 「${shift.name}」排班人數僅 ${scheduled} 人，少於設定需求 ${required} 人！`
        });
      }
    });
  }

  return warnings;
}

// 6. 一鍵智能自動排班引擎 (CSP Backtracking Heuristic Engine)

// 輔助函數：快速校驗單一員工在暫存班表中是否合乎「連續上班不超過 maxDays 天」的限制
function isRosterCompliantWithMaxConsecutive(rosterCopy, empId, maxDays = 5) {
  const boundary = getPreviousMonthBoundaryStats(empId, state.currentYear, state.currentMonth);
  let consecutive = boundary.consecutiveWork;
  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);

  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    const shiftId = rosterCopy[dateStr][empId];
    if (shiftId === 'OFF' || shiftId === 'PTO' || shiftId === 'LOA') {
      consecutive = 0;
    } else {
      consecutive++;
      if (consecutive > maxDays) {
        return false;
      }
    }
  }
  return true;
}

function runAutoScheduler() {
  // 一鍵排班前，自動將客服同仁依預設固定班別進行排序
  sortStaffByShift();

  const year = state.currentYear;
  const month = state.currentMonth;
  const daysCount = getDaysInMonth(year, month);
  const staffList = state.staff;

  const newRoster = {};
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(year, month, d);
    newRoster[dateStr] = {};
  }

  staffList.forEach(emp => {
    // 優先使用該專員設定的預設固定班別。若無設定，則預設為早班 A
    const defShift = emp.defaultWorkShift || 'A';
    const ptoSet = new Set(emp.pto || []);
    
    // 1. 初始化該專員在當月的初始狀態
    const empRoster = {}; // dateStr -> shiftId
    const offDates = [];  // 已排定為休假 (OFF) 的日期
    const ptoDates = [];  // 已排定為特休 (PTO) 的日期
    
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(year, month, d);
      const dayOfWeek = getDayOfWeek(year, month, d);
      const isDefaultOff = emp.defaultOffDays && emp.defaultOffDays.includes(dayOfWeek);
      
      if (ptoSet.has(dateStr)) {
        const leaveType = getLeaveTypeForPtoDay(emp, dateStr);
        empRoster[dateStr] = leaveType;
        if (leaveType === 'PTO') {
          ptoDates.push(dateStr);
        } else {
          offDates.push(dateStr);
        }
      } else if (isDefaultOff) {
        empRoster[dateStr] = 'OFF';
        offDates.push(dateStr);
      } else {
        empRoster[dateStr] = null;
      }
    }

    // 2. 進行連五天強行打斷 Pass (確保連續工作不超過 5 天，並承接上月底連續上班天數)
    const boundary = getPreviousMonthBoundaryStats(emp.id, year, month);
    let consecutive = boundary.consecutiveWork;
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(year, month, d);
      if (empRoster[dateStr] === 'OFF' || empRoster[dateStr] === 'PTO') {
        consecutive = 0;
      } else {
        if (consecutive >= 5) {
          // 強制改為 OFF 以打斷連五
          empRoster[dateStr] = 'OFF';
          offDates.push(dateStr);
          consecutive = 0;
        } else {
          consecutive++;
        }
      }
    }
    
    // 3. 調整休假天數，使其精準等於目標月休天數
    // 重新完整統計所有 OFF 天數（Step 2 可能已插入額外 OFF）
    const recountOff = () => {
      let count = 0;
      for (let d = 1; d <= daysCount; d++) {
        const dateStr = formatDateISO(year, month, d);
        if (empRoster[dateStr] === 'OFF') {
          count++;
        }
      }
      return count;
    };
    let currentOffCount = recountOff();
    const targetOff = state.daysOff;
    
    // 重新取得目前所有的待排工作日 (null)
    const getWorkCandidates = () => {
      const list = [];
      for (let d = 1; d <= daysCount; d++) {
        const dateStr = formatDateISO(year, month, d);
        if (empRoster[dateStr] === null) {
          list.push(dateStr);
        }
      }
      return list;
    };
    
    if (currentOffCount < targetOff) {
      // 假不夠：隨機在待排工作日中補足 OFF (補 OFF 絕不會造成新的連五，非常安全)
      let needed = targetOff - currentOffCount;
      const currentCandidates = getWorkCandidates();
      if (currentCandidates.length > 0) {
        const shuffled = [...currentCandidates].sort(() => Math.random() - 0.5);
        const chosen = shuffled.slice(0, Math.min(needed, shuffled.length));
        chosen.forEach(dateStr => {
          empRoster[dateStr] = 'OFF';
        });
      }
    } else if (currentOffCount > targetOff) {
      // 假太多：將多餘的 OFF 扣除（變回上班 null）
      let excess = currentOffCount - targetOff;
      
      // 判斷要保護 d1 還是 d2 (固定雙休保護規則)
      let protectedDow = -1;
      if (emp.defaultOffDays && emp.defaultOffDays.length === 2) {
        const d1 = emp.defaultOffDays[0];
        const d2 = emp.defaultOffDays[1];
        
        const getDowDemand = (dow) => {
          let total = 0;
          for (let d = 1; d <= daysCount; d++) {
            const dayOfWeek = getDayOfWeek(year, month, d);
            if (dayOfWeek === dow) {
              const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
              state.shifts.forEach(s => {
                if (s.id === 'D') return;
                const targets = state.coverageTargets[s.id] || { weekday: 0, weekend: 0 };
                total += isWeekend ? targets.weekend : targets.weekday;
              });
            }
          }
          return total;
        };
        
        const demand1 = getDowDemand(d1);
        const demand2 = getDowDemand(d2);
        if (demand1 >= demand2) {
          protectedDow = d2; // d1 需求較高，保護 d2 (整個月的 d2 都維持 OFF)
        } else {
          protectedDow = d1; // d2 需求較高，保護 d1 (整個月 the d1 都維持 OFF)
        }
      }
      
      // 區分非預設週休與預設週休的 OFF
      const eligibleNonDefaultOffs = [];
      const eligibleDefaultOffs = [];
      
      for (let d = 1; d <= daysCount; d++) {
        const dateStr = formatDateISO(year, month, d);
        if (empRoster[dateStr] === 'OFF') {
          const dayOfWeek = getDayOfWeek(year, month, d);
          const isDefaultOff = emp.defaultOffDays && emp.defaultOffDays.includes(dayOfWeek);
          if (isDefaultOff) {
            // 如果這天是受保護的固定休假日，則不列入「可扣除」的候選名單，保護它維持為 OFF！
            if (emp.defaultOffDays && emp.defaultOffDays.length === 2 && dayOfWeek === protectedDow) {
              // 被保護，不能扣除
            } else {
              eligibleDefaultOffs.push(dateStr);
            }
          } else {
            eligibleNonDefaultOffs.push(dateStr);
          }
        }
      }
      
      // 隨機打亂
      eligibleNonDefaultOffs.sort(() => Math.random() - 0.5);
      eligibleDefaultOffs.sort(() => Math.random() - 0.5);
      
      const allOffCandidates = [...eligibleNonDefaultOffs, ...eligibleDefaultOffs];
      
      // 嘗試逐一扣除，扣除前進行安全檢查：扣除後是否仍然滿足連續工作不超過 5 天？
      let resolvedCount = 0;
      for (const dateStr of allOffCandidates) {
        if (resolvedCount >= excess) break;
        
        // 暫定改為上班
        empRoster[dateStr] = null;
        
        // 建立臨時的單人 roster 用於合規檢查
        const rosterCopy = {};
        for (let d = 1; d <= daysCount; d++) {
          const dStr = formatDateISO(year, month, d);
          rosterCopy[dStr] = { [emp.id]: empRoster[dStr] };
        }
        
        if (isRosterCompliantWithMaxConsecutive(rosterCopy, emp.id, 5)) {
          // 合規！成功扣除
          resolvedCount++;
        } else {
          // 不合規！復原為 OFF
          empRoster[dateStr] = 'OFF';
        }
      }
      
      // 如果極端情況下仍有扣不掉的假，強制扣除以保障月休天數
      let stillExcess = excess - resolvedCount;
      if (stillExcess > 0) {
        const remainingOffs = [];
        for (let d = 1; d <= daysCount; d++) {
          const dateStr = formatDateISO(year, month, d);
          if (empRoster[dateStr] === 'OFF') {
            remainingOffs.push(dateStr);
          }
        }
        remainingOffs.sort(() => Math.random() - 0.5);
        const forceToWork = remainingOffs.slice(0, Math.min(stillExcess, remainingOffs.length));
        forceToWork.forEach(dateStr => {
          empRoster[dateStr] = null;
        });
      }
    }
    
    // 4. 將剩餘的所有待排工作日填入該專員的「預設固定班別」
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(year, month, d);
      if (empRoster[dateStr] === null) {
        empRoster[dateStr] = defShift;
      }
      // 回寫總班表
      newRoster[dateStr][emp.id] = empRoster[dateStr];
    }
  });

  // --- 4. 進行每日空缺補足與調班支援平衡 Pass ---
  const supportDaysCount = {};
  const supportedShifts = {}; // empId -> Set of non-default shiftIds
  staffList.forEach(emp => {
    supportDaysCount[emp.id] = 0;
    supportedShifts[emp.id] = new Set();
  });

  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(year, month, d);
    const dayOfWeek = getDayOfWeek(year, month, d);
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    // 我們先計算今日哪些班次有缺口，並記錄缺幾個
    const shortages = [];
    state.shifts.forEach(shift => {
      if (shift.id === 'D') return; // D 班是獨立班，不參與常規調度支援
      
      const targetConfig = state.coverageTargets[shift.id] || { weekday: 0, weekend: 0 };
      const required = isWeekend ? targetConfig.weekend : targetConfig.weekday;
      
      // 計算今日排該班次的人數
      let currentScheduled = 0;
      staffList.forEach(emp => {
        if (newRoster[dateStr][emp.id] === shift.id) {
          currentScheduled++;
        }
      });
      
      const diff = required - currentScheduled;
      if (diff > 0) {
        shortages.push({ shiftId: shift.id, count: diff });
      }
    });

    // 對於今日有缺口的班次，嘗試尋找支援
    shortages.forEach(shortage => {
      for (let i = 0; i < shortage.count; i++) {
        // 尋找最合適的支援人員
        let bestEmpId = null;
        let lowestSupportDays = Infinity;
        
        staffList.forEach(emp => {
          // 獨立班別人員(D)不參與支援調班
          if (emp.defaultWorkShift === 'D') return;

          const currentShift = newRoster[dateStr][emp.id];
          // 如果他今天沒上班 (OFF, PTO, LOA, AM_PTO, PM_PTO) 或是已經在排這個缺口班別，就不能支援
          const leaveTypes = ['OFF', 'PTO', 'LOA', 'AM_PTO', 'PM_PTO'];
          if (leaveTypes.includes(currentShift) || currentShift === shortage.shiftId) return;

          const defShift = emp.defaultWorkShift || 'A';
          
          // 限制不可跨越兩個班別：早班(A)不支援晚班(C)，晚班(C)不支援早班(A)
          if (defShift === 'A' && shortage.shiftId === 'C') return;
          if (defShift === 'C' && shortage.shiftId === 'A') return;
          
          // 支援限制檢查:
          // 1. 他本月支援過的其他班別種類限制（扣除他自己的預設班別）
          const tempSet = new Set(supportedShifts[emp.id]);
          if (shortage.shiftId !== defShift) {
            tempSet.add(shortage.shiftId);
          }
          if (tempSet.size > 1) return; // 超過一種支援班別限制！

          // 2. 11小時輪班間隔限制 (前一天與後一天)
          // 檢查前一天
          if (d > 1) {
            const prevDateStr = formatDateISO(year, month, d - 1);
            const prevShiftId = newRoster[prevDateStr][emp.id];
            const prevS = state.shifts.find(s => s.id === prevShiftId);
            const currS = state.shifts.find(s => s.id === shortage.shiftId);
            const leaveTypes = ['OFF', 'PTO', 'LOA', 'AM_PTO', 'PM_PTO'];
            if (prevS && currS && !leaveTypes.includes(prevShiftId)) {
              if (calculateRestHours(prevS, currS) < 11) return;
            }
          }
          // 檢查後一天
          if (d < daysCount) {
            const nextDateStr = formatDateISO(year, month, d + 1);
            const nextShiftId = newRoster[nextDateStr][emp.id];
            const currS = state.shifts.find(s => s.id === shortage.shiftId);
            const nextS = state.shifts.find(s => s.id === nextShiftId);
            const leaveTypes = ['OFF', 'PTO', 'LOA', 'AM_PTO', 'PM_PTO'];
            if (currS && nextS && !leaveTypes.includes(nextShiftId)) {
              if (calculateRestHours(currS, nextS) < 11) return;
            }
          }

          // 如果此人合規，比對其累積支援天數以維持平均
          const days = supportDaysCount[emp.id];
          if (days < lowestSupportDays) {
            lowestSupportDays = days;
            bestEmpId = emp.id;
          }
        });

        // 如果找到了最適合支援的人
        if (bestEmpId) {
          newRoster[dateStr][bestEmpId] = shortage.shiftId;
          
          // 更新支援狀態
          supportDaysCount[bestEmpId]++;
          const defShift = state.staff.find(e => e.id === bestEmpId).defaultWorkShift || 'A';
          if (shortage.shiftId !== defShift) {
            supportedShifts[bestEmpId].add(shortage.shiftId);
          }
        }
      }
    });
  }

  // 5. 將結果套用至系統狀態並標記未儲存
  rebuildSortedStaffIds();
  state.roster = newRoster;
  state.hasUnsavedChanges = true;
  updateUnsavedChangesUI();
}

// 隨機排入多餘的休假天數 (避開預設休假日與特休，符合勞基法)
function reduceExcessOffDays(newRoster, daysCount) {
  const staffList = state.staff;
  const shiftList = state.shifts;
  const regularShiftIds = shiftList.filter(s => s.id !== 'D').map(s => s.id);

  if (regularShiftIds.length === 0) return;

  staffList.forEach(emp => {
    // 1. 計算該員工當前總休假天數 (OFF)
    let totalOffDays = 0;
    const offDates = []; // 儲存所有排定為 'OFF' 的日期
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const shiftId = newRoster[dateStr][emp.id];
      if (shiftId === 'OFF') {
        totalOffDays++;
        offDates.push({ d, dateStr });
      }
    }

    // 2. 如果休假大於設定的目標休假天數
    let excessCount = totalOffDays - state.daysOff;
    if (excessCount <= 0) return;

    // 3. 篩選符合條件的 'OFF' 日期：非預設休假日，且非特休 (PTO 已排除在 offDates 中，因為 PTO 的 shiftId 是 'PTO')
    const eligibleDates = offDates.filter(item => {
      const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, item.d);
      const isDefaultOff = emp.defaultOffDays && emp.defaultOffDays.includes(dayOfWeek);
      return !isDefaultOff;
    });

    if (eligibleDates.length === 0) return;

    // 隨機打亂候選日期，以達到隨機分佈效果
    eligibleDates.sort(() => Math.random() - 0.5);

    // 4. 嘗試將多餘的休假隨機排入上班日中
    let resolvedCount = 0;
    for (const item of eligibleDates) {
      if (resolvedCount >= excessCount) break;

      // 隨機打亂常規班次
      const shuffledShifts = [...regularShiftIds].sort(() => Math.random() - 0.5);
      let assigned = false;

      for (const shiftId of shuffledShifts) {
        // 暫時指派該班次
        newRoster[item.dateStr][emp.id] = shiftId;

        // 檢查是否符合勞基法與排班規則 (7休1, 11小時輪班間隔)
        if (isEmployeeRosterCompliant(newRoster, daysCount, emp.id)) {
          resolvedCount++;
          assigned = true;
          break; // 成功指派，換下一天
        } else {
          // 復原為 OFF
          newRoster[item.dateStr][emp.id] = 'OFF';
        }
      }
    }
  });
}

// 快速檢查單個員工的排班是否符合勞基法合規 (7休1, 11小時輪班間隔)
function isEmployeeRosterCompliant(rosterCopy, daysCount, empId) {
  const emp = state.staff.find(e => e.id === empId);
  if (!emp) return false;

  const shiftMap = new Map(state.shifts.map(s => [s.id, s]));
  shiftMap.set('OFF', { id: 'OFF', name: '休假', start: '00:00', end: '00:00' });
  shiftMap.set('PTO', { id: 'PTO', name: '特休', start: '00:00', end: '00:00' });
  shiftMap.set('LOA', { id: 'LOA', name: '體檢', start: '00:00', end: '00:00' });
  shiftMap.set('AM_PTO', { id: 'AM_PTO', name: '上午特休', start: '00:00', end: '00:00' });
  shiftMap.set('PM_PTO', { id: 'PM_PTO', name: '下午特休', start: '00:00', end: '00:00' });

  // 智慧跨月邊界檢查，承接上月歷史數據以校驗連續天數及輪班間隔
  const boundary = getPreviousMonthBoundaryStats(empId, state.currentYear, state.currentMonth);
  let consecutive = boundary.consecutiveWork;
  let prevId = boundary.lastShiftId;

  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    const shiftId = rosterCopy[dateStr][empId] || 'OFF';
    const isWork = (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA');

    // 1. 7休1原則 (連續上班不能超過 6 天)
    if (isWork) {
      consecutive++;
      if (consecutive > 6) {
        return false;
      }
    } else {
      consecutive = 0;
    }

    // 2. 11小時輪班間隔檢查
    if (prevId && shiftId) {
      const prevS = shiftMap.get(prevId);
      const currS = shiftMap.get(shiftId);
      const leaveTypes = ['OFF', 'PTO', 'LOA', 'AM_PTO', 'PM_PTO'];
      if (prevS && currS && !leaveTypes.includes(prevId) && !leaveTypes.includes(shiftId)) {
        if (calculateRestHours(prevS, currS) < 11) {
          return false;
        }
      }
    }
    
    // 3. PTO 檢查
    if (emp.pto.includes(dateStr) && shiftId !== 'PTO' && shiftId !== 'AM_PTO' && shiftId !== 'PM_PTO') {
      return false;
    }

    prevId = shiftId;
  }

  // 4. 兩天固定休假日中至少有一天整個月完全不被動到
  if (!isEmployeeDefaultOffDaysConstraintCompliant(rosterCopy, empId, state.currentYear, state.currentMonth)) {
    return false;
  }

  return true;
}

// 交換優化演算法：微調每人休假天數，使其精準等於目標固定休假天數 (e.g. 8天)
function adjustRosterForExactDaysOff(newRoster, daysCount) {
  const staffList = state.staff;
  const shiftList = state.shifts;
  
  // 重複執行數次交換以收斂結果
  for (let iteration = 0; iteration < 3; iteration++) {
    // 重新計算每個人的休假總天數 (僅計算一般休假 OFF)
    const offCounts = {};
    staffList.forEach(emp => {
      offCounts[emp.id] = 0;
      for (let d = 1; d <= daysCount; d++) {
        const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
        const sId = newRoster[dateStr][emp.id];
        if (sId === 'OFF') {
          offCounts[emp.id]++;
        }
      }
    });

    // 找出休假不足與休假過多的人
    const underOff = staffList.filter(emp => offCounts[emp.id] < state.daysOff);
    const overOff = staffList.filter(emp => offCounts[emp.id] > state.daysOff);

    if (underOff.length === 0 || overOff.length === 0) break; // 已全部符合或無法再平衡

    // 嘗試在 underOff(少休假) 與 overOff(多休假) 之間尋找一天進行「工作/休假交換」
    let exchanged = false;
    for (let uEmp of underOff) {
      for (let oEmp of overOff) {
        // 尋找某一天 d：oEmp 排休假，uEmp 排工作
        for (let d = 1; d <= daysCount; d++) {
          const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
          const uShiftId = newRoster[dateStr][uEmp.id];
          const oShiftId = newRoster[dateStr][oEmp.id];

          // 且這天不是兩人的申請特休 (PTO)
          if (uShiftId !== 'OFF' && uShiftId !== 'PTO' && oShiftId === 'OFF') {
            
            // 進行預擬交換
            // uEmp 排 OFF，oEmp 排 uShiftId
            // 檢查交換後是否會引發更嚴重的勞基法違規 (11小時, 7休1)
            newRoster[dateStr][uEmp.id] = 'OFF';
            newRoster[dateStr][oEmp.id] = uShiftId;

            const tempWarnings = checkLaborComplianceForSwap(newRoster, daysCount, uEmp.id, oEmp.id);
            const hasSeriousViolations = tempWarnings.some(w => w.severity === 'error');

            if (!hasSeriousViolations) {
              // 成功交換，跳出此輪
              exchanged = true;
              break;
            } else {
              // 復原
              newRoster[dateStr][uEmp.id] = uShiftId;
              newRoster[dateStr][oEmp.id] = 'OFF';
            }
          }
        }
        if (exchanged) break;
      }
      if (exchanged) break;
    }
    if (!exchanged) break; // 找不到無衝突的交換方案，終止避免無窮迴圈
  }
}

// 快速檢查交換後的合規性 (僅回傳錯誤)
function checkLaborComplianceForSwap(rosterCopy, daysCount, empId1, empId2) {
  const warnings = [];
  const targetEmps = [empId1, empId2];
  const shiftMap = new Map(state.shifts.map(s => [s.id, s]));
  shiftMap.set('OFF', { id: 'OFF', name: '休假', start: '00:00', end: '00:00' });
  shiftMap.set('PTO', { id: 'PTO', name: '特休', start: '00:00', end: '00:00' });
  shiftMap.set('LOA', { id: 'LOA', name: '體檢', start: '00:00', end: '00:00' });
  shiftMap.set('AM_PTO', { id: 'AM_PTO', name: '上午特休', start: '00:00', end: '00:00' });
  shiftMap.set('PM_PTO', { id: 'PM_PTO', name: '下午特休', start: '00:00', end: '00:00' });

  targetEmps.forEach(empId => {
    let consecutive = 0;
    let prevId = null;
    const emp = state.staff.find(e => e.id === empId);
    if (!emp) return;

    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const shiftId = rosterCopy[dateStr][empId] || 'OFF';
      const isWork = (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA');

      if (isWork) {
        consecutive++;
        if (consecutive > 6) {
          warnings.push({ severity: 'error' });
        }
      } else {
        consecutive = 0;
      }

      if (d > 1 && prevId && shiftId) {
        const prevS = shiftMap.get(prevId);
        const currS = shiftMap.get(shiftId);
        const leaveTypes = ['OFF', 'PTO', 'LOA', 'AM_PTO', 'PM_PTO'];
        if (prevS && currS && !leaveTypes.includes(prevId) && !leaveTypes.includes(shiftId)) {
          if (calculateRestHours(prevS, currS) < 11) {
            warnings.push({ severity: 'error' });
          }
        }
      }
      
      // PTO 檢查
      if (emp.pto.includes(dateStr) && shiftId !== 'PTO' && shiftId !== 'AM_PTO' && shiftId !== 'PM_PTO') {
        warnings.push({ severity: 'error' });
      }

      prevId = shiftId;
    }
    
    // 兩天固定休假日中至少有一天整個月完全不被動到
    if (!isEmployeeDefaultOffDaysConstraintCompliant(rosterCopy, empId, state.currentYear, state.currentMonth)) {
      warnings.push({ severity: 'error' });
    }
  });
  return warnings;
}

// 7. UI 渲染功能 (DOM Rendering Engine)

// A. 初始化下拉年月選單
function populateYearMonthSelectors() {
  const yearSelect = document.getElementById('schedule-year');
  const monthSelect = document.getElementById('schedule-month');

  const currentYear = new Date().getFullYear();
  yearSelect.innerHTML = '';
  // 可排今年、明年與後年
  for (let y = currentYear; y <= currentYear + 2; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = `${y} 年`;
    yearSelect.appendChild(opt);
  }

  yearSelect.value = state.currentYear;
  monthSelect.value = state.currentMonth;
}

// B. 渲染排班大圖表 (Horizontal Gantt timeline matrix)
function renderRosterGrid() {
  const grid = document.getElementById('roster-main-grid');
  grid.innerHTML = '';

  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);
  const staffList = state.staff;
  const shiftList = state.shifts;

  if (staffList.length === 0) {
    grid.innerHTML = `<tr><td style="padding: 24px; text-align: center; color: var(--text-muted);">請先在左側新增客服人員！</td></tr>`;
    return;
  }

  const sortedStaff = getSortedStaffForOverview(staffList);

  // --- 1. 產生表頭 (Header Row 1 & 2) ---
  const headerRow = document.createElement('tr');
  
  // 客服姓名固定欄
  const nameTh = document.createElement('th');
  nameTh.className = 'col-staff-name';
  nameTh.innerHTML = '客服人員';
  headerRow.appendChild(nameTh);

  // 產生 1 到 N 號的日期欄
  for (let d = 1; d <= daysCount; d++) {
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    
    const th = document.createElement('th');
    if (isWeekend) th.className = 'date-weekend';
    
    th.innerHTML = `
      <div class="date-header">
        <span class="date-num">${d}</span>
        <span class="date-day">${getDayOfWeekName(dayOfWeek)}</span>
      </div>
    `;
    headerRow.appendChild(th);
  }
  grid.appendChild(headerRow);

  // --- 2. 產生各人員排班列 (Body Rows) ---
  // 先獲取即時合規稽核結果，用以動態畫出紅光警告
  const currentWarnings = auditRoster(state.currentYear, state.currentMonth);

  sortedStaff.forEach(employee => {
    const row = document.createElement('tr');
    
    // 客服姓名
    const tdName = document.createElement('td');
    tdName.className = 'col-staff-name';
    
    // 加個漂亮的小頭像與編輯喜好按鈕
    tdName.innerHTML = `
      <div class="staff-card-info" style="justify-content: space-between; width: 100%; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="staff-avatar">${employee.name.charAt(0)}</div>
          <div style="display: flex; flex-direction: column;">
            <span class="staff-name">${employee.name}</span>
          </div>
        </div>
        <button class="btn-icon btn-xs btn-edit-pref" data-id="${employee.id}" title="偏好與特休" style="width:24px; height:24px; border-radius:4px;">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px; height:12px;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    `;
    row.appendChild(tdName);

    // 產生 1 到 N 號的班表 Cell
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      
      const tdCell = document.createElement('td');
      tdCell.className = 'roster-cell';
      if (isWeekend) tdCell.classList.add('date-weekend');

      // 讀取當天指派的班次
      const assignedShiftId = (state.roster[dateStr] && state.roster[dateStr][employee.id]) || 'OFF';

      // 檢查這個格子是否在違規報告中 (紅光警告標識)
      const hasConflict = currentWarnings.some(w => w.employeeId === employee.id && w.date === dateStr && w.severity === 'error');
      
      // 檢查是否為調班支援班次 (非預設工作班別，且非休假特休與假別)
      const defShift = employee.defaultWorkShift || 'A';
      const isSupportShift = (assignedShiftId !== 'OFF' && assignedShiftId !== 'PTO' && assignedShiftId !== 'LOA' && assignedShiftId !== 'AM_PTO' && assignedShiftId !== 'PM_PTO' && assignedShiftId !== defShift);

      // 繪製格子的 Shift Badge
      let badgeLabel = assignedShiftId;
      let badgeClass = `shift-${assignedShiftId}`;
      
      if (assignedShiftId === 'OFF') {
        badgeLabel = '休';
      } else if (assignedShiftId === 'PTO') {
        badgeLabel = '特';
      } else if (assignedShiftId === 'LOA') {
        badgeLabel = 'LOA';
      } else if (assignedShiftId === 'AM_PTO') {
        badgeLabel = '上特';
      } else if (assignedShiftId === 'PM_PTO') {
        badgeLabel = '下特';
      } else {
        // 顯示班次起始時間
        const matchedShift = shiftList.find(s => s.id === assignedShiftId);
        if (matchedShift) {
          badgeLabel = matchedShift.start;
          if (isSupportShift) {
            badgeLabel += '*';
          }
          badgeClass = `shift-${matchedShift.colorClass || 'custom'}`;
        }
      }

      // 檢查這個格子是否被手動修改過
      const isManuallyEdited = state.manualEdits && state.manualEdits[`${dateStr}_${employee.id}`];

      // 格子內部 DOM 結構：結合下拉隱形 Selector 以便滑動點擊調整班表
      const cellInner = document.createElement('div');
      cellInner.className = `roster-cell-inner ${hasConflict ? 'cell-warning-glow' : ''} ${isSupportShift ? 'cell-support-assigned' : ''} ${isManuallyEdited ? 'cell-manually-edited' : ''}`;
      cellInner.dataset.employeeId = employee.id;
      cellInner.dataset.date = dateStr;
      
      // 建立下拉選單內容 (隱形於滑鼠懸停) - 任何人都可以直接手動調整為任何班別 (包括獨立班D)
      let selectOptions = `
        <option value="OFF" ${assignedShiftId === 'OFF' ? 'selected' : ''}>休假 (OFF)</option>
        <option value="PTO" ${assignedShiftId === 'PTO' ? 'selected' : ''}>特休 (PTO)</option>
        <option value="LOA" ${assignedShiftId === 'LOA' ? 'selected' : ''}>體檢 (LOA)</option>
        <option value="AM_PTO" ${assignedShiftId === 'AM_PTO' ? 'selected' : ''}>上午特休 (上特)</option>
        <option value="PM_PTO" ${assignedShiftId === 'PM_PTO' ? 'selected' : ''}>下午特休 (下特)</option>
      `;
      shiftList.forEach(s => {
        selectOptions += `<option value="${s.id}" ${assignedShiftId === s.id ? 'selected' : ''}>${s.name} (${s.start}-${s.end})</option>`;
      });

      cellInner.innerHTML = `
        <span class="shift-badge ${badgeClass}">${badgeLabel}</span>
        ${hasConflict ? '<span class="cell-warning-badge" title="勞基法違規衝突！點下方衝突報告檢視"></span>' : ''}
        <div class="cell-select-wrapper">
          <select class="cell-select" data-employee-id="${employee.id}" data-date="${dateStr}">
            ${selectOptions}
          </select>
        </div>
      `;

      tdCell.appendChild(cellInner);
      row.appendChild(tdCell);
    }
    grid.appendChild(row);
  });

  // --- 3. 產生「每日可額外休假 (PTO) 額度」列 ---
  const ptoRow = document.createElement('tr');
  ptoRow.className = 'roster-extra-pto-row';
  
  // 欄位名稱
  const tdPtoTitle = document.createElement('td');
  tdPtoTitle.className = 'col-staff-name';
  tdPtoTitle.style.background = 'rgba(16, 185, 129, 0.08)';
  tdPtoTitle.style.borderTop = '2px solid var(--accent-green)';
  tdPtoTitle.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 1.2rem;">🌴</span>
      <div>
        <span class="staff-name" style="color: var(--accent-green); font-weight: 700;">可再休 PTO</span>
        <div class="staff-desc" style="color: var(--text-secondary);">當日剩餘休假額度</div>
      </div>
    </div>
  `;
  ptoRow.appendChild(tdPtoTitle);

  // 產生 1 到 N 號的額度單元格
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    
    const tdPtoCell = document.createElement('td');
    tdPtoCell.className = 'roster-cell';
    tdPtoCell.style.borderTop = '2px solid var(--accent-green)';
    tdPtoCell.style.background = 'rgba(16, 185, 129, 0.04)';
    if (isWeekend) tdPtoCell.classList.add('date-weekend');

    // 計算當日最低人力需求 (所有班次的目標之和)
    let minRequired = 0;
    shiftList.forEach(s => {
      const targetConfig = state.coverageTargets[s.id] || { weekday: 0, weekend: 0 };
      minRequired += isWeekend ? targetConfig.weekend : targetConfig.weekday;
    });

    // 計算當日已排班人數 (非 OFF/PTO/LOA，且排除獨立班D)
    let activeWorking = 0;
    staffList.forEach(emp => {
      if (emp.defaultWorkShift === 'D') return;
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      if (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA') {
        if (shiftId === 'AM_PTO' || shiftId === 'PM_PTO') {
          activeWorking += 0.5;
        } else {
          activeWorking++;
        }
      }
    });

    // 額外可休額度 = 已排班人數 - 最低人力需求
    const extraPtoAvailable = Math.max(0, activeWorking - minRequired);

    let quotaBadgeClass = 'shift-OFF';
    let quotaLabel = '0';
    if (extraPtoAvailable > 0) {
      quotaBadgeClass = 'shift-A'; // 綠色樣式
      quotaLabel = `+${extraPtoAvailable}`;
    }

    tdPtoCell.innerHTML = `
      <div class="roster-cell-inner" style="cursor: default;" title="當日已排上班人數: ${activeWorking}人, 最低需求: ${minRequired}人. 可再准假 ${extraPtoAvailable}人。">
        <span class="shift-badge ${quotaBadgeClass}" style="border-radius: 50%; font-size: 0.8rem; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 6px rgba(16,185,129,0.2);">${quotaLabel}</span>
      </div>
    `;
    ptoRow.appendChild(tdPtoCell);
  }
  grid.appendChild(ptoRow);


  // 綁定動態產生的行事曆儲存格事件 (Dropdown 調整班表)
  document.querySelectorAll('.cell-select').forEach(select => {
    select.addEventListener('change', function(e) {
      const empId = this.dataset.employeeId;
      const date = this.dataset.date;
      const newShiftId = this.value;

      // 保存目前狀態以利「上一步」復原
      pushUndoState();

      if (!state.roster[date]) {
        state.roster[date] = {};
      }

      // 判斷是否變更 (與上次儲存的 backupRoster 比對)
      const originalShiftId = (state.backupRoster[date] && state.backupRoster[date][empId]) || 'OFF';
      if (!state.manualEdits) {
        state.manualEdits = {};
      }
      if (newShiftId !== originalShiftId) {
        state.manualEdits[`${date}_${empId}`] = true;
      } else {
        delete state.manualEdits[`${date}_${empId}`];
      }

      state.roster[date][empId] = newShiftId;
      
      state.hasUnsavedChanges = true;
      updateUnsavedChangesUI();
      renderAll(); // 即時重繪，重新跑勞基法合規稽核！
    });
  });

  // 綁定修改喜好按鈕
  document.querySelectorAll('.btn-edit-pref').forEach(btn => {
    btn.addEventListener('click', function() {
      const empId = this.dataset.id;
      openEmployeeConfigModal(empId);
    });
  });
}

// C. 渲染排班圖例 (Roster Legend)
function renderLegend() {
  const legend = document.getElementById('roster-legend-container');
  legend.innerHTML = '';

  // 系統預設休假與特休圖例
  legend.innerHTML += `
    <div class="legend-item"><span class="shift-badge btn-xs shift-OFF" style="width:20px; height:20px;">休</span> <span>休假</span></div>
    <div class="legend-item"><span class="shift-badge btn-xs shift-PTO" style="width:20px; height:20px;">特</span> <span>特休</span></div>
  `;

  // 動態班次圖例
  state.shifts.forEach(s => {
    legend.innerHTML += `
      <div class="legend-item">
        <span class="shift-badge btn-xs shift-${s.colorClass || 'custom'}" style="width:20px; height:20px;">${s.name.substring(0, 2)}</span>
        <span>${s.name} (${s.start}-${s.end})</span>
      </div>
    `;
  });
}

// D. 渲染側邊欄客服人員名單 (Staff List Panel) — 固定依姓名 A-Z 字母排序
function renderStaffList() {
  const container = document.getElementById('staff-list');
  container.innerHTML = '';

  if (state.staff.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">尚無在職人員</div>`;
    return;
  }

  // 建立依姓名 A-Z 排序的副本（不影響 state.staff 原始順序）
  const alphabeticallySorted = [...state.staff].sort((a, b) => a.name.localeCompare(b.name));

  alphabeticallySorted.forEach(emp => {
    const card = document.createElement('div');
    card.className = 'staff-card';
    card.dataset.id = emp.id;

    // 顯示該員工目前的預設班別標示
    const shiftLabel = state.shifts.find(s => s.id === emp.defaultWorkShift);
    const shiftTag = shiftLabel ? `${shiftLabel.name}` : emp.defaultWorkShift || 'A';

    card.innerHTML = `
      <div class="staff-card-info">
        <div class="staff-avatar">${emp.name.charAt(0)}</div>
        <div class="staff-details">
          <span class="staff-name">${emp.name}</span>
          <span class="staff-desc">預設: ${shiftTag} ｜ 特休: ${(emp.pto || []).filter(d => d.startsWith(`${state.currentYear}-${String(state.currentMonth + 1).padStart(2, '0')}`)).length} 天</span>
        </div>
      </div>
      <div class="staff-actions">
        <button class="btn-icon btn-xs btn-staff-pref" data-id="${emp.id}" title="喜好設定">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px; height:14px;"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="btn-icon btn-xs btn-delete-staff text-red" data-id="${emp.id}" title="刪除人員">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px; height:14px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  // 綁定編輯與刪除按鈕事件
  document.querySelectorAll('.btn-staff-pref').forEach(btn => {
    btn.addEventListener('click', function() {
      openEmployeeConfigModal(this.dataset.id);
    });
  });

  document.querySelectorAll('.btn-delete-staff').forEach(btn => {
    btn.addEventListener('click', function() {
      const empId = this.dataset.id;
      const empName = state.staff.find(e => e.id === empId)?.name || '該人員';
      if (confirm(`確定要刪除「${empName}」嗎？其相關的排班記錄也會一併清除。`)) {
        deleteStaff(empId);
      }
    });
  });
}

// E. 渲染側邊欄班別與人力覆蓋需求 (Shifts Panel)
function renderShiftsList() {
  const container = document.getElementById('shift-definitions-list');
  container.innerHTML = '';

  state.shifts.forEach(s => {
    const card = document.createElement('div');
    card.className = 'shift-card';
    
    // 預設核心班別不能刪除，自訂班別可以刪除
    const isSystem = (s.type === 'system');
    const deleteBtn = isSystem 
      ? `<span class="shift-hours-label">預設核心</span>` 
      : `<button class="btn-icon btn-xs btn-delete-shift text-red" data-id="${s.id}" title="刪除班次">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px; height:12px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
         </button>`;

    card.innerHTML = `
      <div class="shift-card-main">
        <span class="shift-pill-badge shift-${s.colorClass || 'custom'}">${s.id}</span>
        <div class="shift-card-times">
          <span class="shift-time-range">${s.name} ${s.start} - ${s.end}</span>
        </div>
      </div>
      <div>
        ${deleteBtn}
      </div>
    `;
    container.appendChild(card);
  });

  // 綁定自訂班別刪除事件
  document.querySelectorAll('.btn-delete-shift').forEach(btn => {
    btn.addEventListener('click', function() {
      const shiftId = this.dataset.id;
      if (confirm(`確定要刪除「${shiftId}」班別嗎？已排定的相關班次會變更為休假！`)) {
        deleteShift(shiftId);
      }
    });
  });

  // 渲染班別人力覆蓋需求輸入表格
  renderCoverageTargetsTable();
}

function renderCoverageTargetsTable() {
  const tbody = document.getElementById('coverage-targets-body');
  tbody.innerHTML = '';

  state.shifts.forEach(s => {
    const target = state.coverageTargets[s.id] || { weekday: 0, weekend: 0 };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="shift-pill-badge shift-${s.colorClass || 'custom'}">${s.name}</span></td>
      <td>
        <input type="number" class="form-control short-input coverage-input" data-shift="${s.id}" data-type="weekday" value="${target.weekday}" min="0" max="10">
      </td>
      <td>
        <input type="number" class="form-control short-input coverage-input" data-shift="${s.id}" data-type="weekend" value="${target.weekend}" min="0" max="10">
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 綁定覆蓋率數值變更事件
  document.querySelectorAll('.coverage-input').forEach(input => {
    input.addEventListener('change', function() {
      const sId = this.dataset.shift;
      const type = this.dataset.type;
      const val = parseInt(this.value) || 0;

      if (!state.coverageTargets[sId]) {
        state.coverageTargets[sId] = { weekday: 0, weekend: 0 };
      }
      state.coverageTargets[sId][type] = val;
      
      saveToLocalStorage();
      renderAll(); // 重繪，並重新跑覆蓋率合規稽核！
    });
  });
}

// F. 渲染側邊欄排班公平性儀表板 (Fairness Panel)
function renderFairnessDashboard() {
  const container = document.getElementById('fairness-chart-list');
  container.innerHTML = '';

  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);
  const staffList = state.staff;
  const shiftList = state.shifts;

  if (staffList.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">尚無人員數據</div>`;
    return;
  }

  // 統計每個人排班各項指標
  const stats = staffList.map(emp => {
    const counts = { 
      A: 0, B: 0, C: 0, OFF: 0, PTO: 0, LOA: 0, AM_PTO: 0, PM_PTO: 0, custom: 0, totalWorkHours: 0,
      xinyiDays: 0, weekdayOffCount: 0, weekendOffCount: 0
    };
    
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

      if (shiftId === 'OFF') {
        counts.OFF++;
        if (isWeekend) counts.weekendOffCount++;
        else counts.weekdayOffCount++;
      } else if (shiftId === 'PTO') {
        counts.PTO++;
        if (isWeekend) counts.weekendOffCount++;
        else counts.weekdayOffCount++;
      } else if (shiftId === 'LOA') {
        counts.LOA++;
        if (isWeekend) counts.weekendOffCount++;
        else counts.weekdayOffCount++;
      } else if (shiftId === 'AM_PTO') {
        counts.AM_PTO++;
        counts.totalWorkHours += 4;
      } else if (shiftId === 'PM_PTO') {
        counts.PM_PTO++;
        counts.totalWorkHours += 4;
      } else {
        // 累計各班別工時 (標準實計工時 8 小時)
        counts.totalWorkHours += 8;

        if (shiftId === 'A') {
          counts.A++;
          if (!isWeekend) counts.xinyiDays++;
        }
        else if (shiftId === 'B') counts.B++;
        else if (shiftId === 'C') counts.C++;
        else counts.custom++;
      }
    }
    return { emp, counts };
  });

  // 排序：依預設班別優先級與預設休假天排序（與班表總覽一致）
  const shiftPriority = {};
  state.shifts.forEach((s, idx) => { shiftPriority[s.id] = idx; });
  stats.sort((a, b) => {
    const pa = shiftPriority[a.emp.defaultWorkShift] ?? 999;
    const pb = shiftPriority[b.emp.defaultWorkShift] ?? 999;
    if (pa !== pb) return pa - pb;
    
    const getOffDaysPriority = (defaultOffDays) => {
      if (!defaultOffDays || !Array.isArray(defaultOffDays)) return 4;
      const has = (day) => defaultOffDays.includes(day);
      if (has(0) && has(1)) return 1;
      if (has(3) && has(4)) return 2;
      if (has(5) && has(6)) return 3;
      return 4;
    };
    
    const pua = getOffDaysPriority(a.emp.defaultOffDays);
    const pub = getOffDaysPriority(b.emp.defaultOffDays);
    if (pua !== pub) return pua - pub;
    
    return a.emp.name.localeCompare(b.emp.name);
  });

  // 渲染公平性面板 — 以帶色彩標籤顯示天數與佔比
  // 滿分理想工時參考：本月上班天數 * 8 小時
  const maxIdealHours = (daysCount - state.daysOff) * 8;

  stats.forEach(({ emp, counts }) => {
    const totalDays = daysCount;

    // 建構各班別標籤資料 (僅顯示天數 > 0 的)
    const tags = [];
    if (counts.A > 0) tags.push({ label: '早班', days: counts.A, cls: 'fairness-bar-early' });
    if (counts.B > 0) tags.push({ label: '中班', days: counts.B, cls: 'fairness-bar-middle' });
    if (counts.C > 0) tags.push({ label: '晚班', days: counts.C, cls: 'fairness-bar-late' });
    if (counts.custom > 0) tags.push({ label: '自訂', days: counts.custom, cls: 'fairness-bar-custom' });
    if (counts.OFF > 0) tags.push({ label: '休假', days: counts.OFF, cls: 'fairness-bar-off' });
    if (counts.PTO > 0) tags.push({ label: '特休', days: counts.PTO, cls: 'fairness-bar-pto' });
    if (counts.LOA > 0) tags.push({ label: 'LOA', days: counts.LOA, cls: 'fairness-bar-loa' });
    if (counts.AM_PTO + counts.PM_PTO > 0) tags.push({ label: '半特', days: counts.AM_PTO + counts.PM_PTO, cls: 'fairness-bar-half-pto' });

    const tagsHtml = tags.map(t => {
      const pct = ((t.days / totalDays) * 100).toFixed(0);
      return `<span class="fairness-tag ${t.cls}">${t.label} ${t.days}天 (${pct}%)</span>`;
    }).join('');

    const item = document.createElement('div');
    item.className = 'fairness-staff-item';
    item.innerHTML = `
      <div class="fairness-staff-header">
        <span class="fairness-staff-name">${emp.name}</span>
        <span class="fairness-staff-hours">實計工時: ${counts.totalWorkHours} hrs</span>
      </div>
      <div class="fairness-tags-row">${tagsHtml}</div>
      <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 12px; padding: 0 2px; border-bottom: 1px dashed rgba(255,255,255,0.05); padding-bottom: 6px;">
        <span>🏢 信義辦公: <strong style="color: var(--accent-blue);">${counts.xinyiDays}</strong> 天</span>
        <span>🌴 平日休: <strong style="color: var(--text-primary);">${counts.weekdayOffCount}</strong> 天 / 假日休: <strong style="color: var(--text-primary);">${counts.weekendOffCount}</strong> 天</span>
      </div>
    `;
    container.appendChild(item);
  });
}

// G. 渲染底部合規衝突警告報告 (Warnings Panel)
function renderWarningsReport() {
  const panel = document.getElementById('warnings-panel');
  const list = document.getElementById('warning-list-items');
  const countSpan = document.getElementById('warning-count');

  const currentWarnings = auditRoster(state.currentYear, state.currentMonth);
  
  if (currentWarnings.length === 0) {
    panel.classList.add('display-none');
    
    // 更新 Dashboard 上方的 Metric Card (若 DOM 存在才更新，防止替換備忘錄後報錯)
    const statCompliance = document.getElementById('stat-compliance');
    if (statCompliance) {
      statCompliance.textContent = '100%';
    }
    const complianceText = document.getElementById('stat-compliance-text');
    if (complianceText) {
      complianceText.textContent = '無勞基法違規項目';
      complianceText.className = 'metric-desc text-green';
    }
    const container = document.getElementById('compliance-icon-container');
    if (container) {
      container.className = 'metric-icon icon-green';
    }
    return;
  }

  // 顯示衝突面板
  panel.classList.remove('display-none');
  list.innerHTML = '';
  
  // 過濾出 error (違規) 與 warning (警告) 的數量
  const errors = currentWarnings.filter(w => w.severity === 'error');
  countSpan.textContent = currentWarnings.length;

  // 更新 Dashboard 上方的 Metric Card (若 DOM 存在才更新，防止替換備忘錄後報錯)
  const compliancePct = Math.max(0, 100 - (errors.length * 15));
  const statCompliance = document.getElementById('stat-compliance');
  if (statCompliance) {
    statCompliance.textContent = `${compliancePct}%`;
  }
  
  const complianceText = document.getElementById('stat-compliance-text');
  const container = document.getElementById('compliance-icon-container');
  
  if (errors.length > 0) {
    if (complianceText) {
      complianceText.textContent = `偵測到 ${errors.length} 項勞基法合規錯誤！`;
      complianceText.className = 'metric-desc text-red';
    }
    if (container) {
      container.className = 'metric-icon icon-red animate-float-slow'; // 警告卡片震動/漂浮
    }
  } else {
    if (complianceText) {
      complianceText.textContent = `勞基法合規，有 ${currentWarnings.length} 項覆蓋率警告`;
      complianceText.className = 'metric-desc text-orange';
    }
    if (container) {
      container.className = 'metric-icon icon-orange';
    }
  }

  // 填充底部警告條目
  currentWarnings.forEach(w => {
    const li = document.createElement('li');
    li.className = 'warning-item';
    if (w.severity === 'error') {
      li.style.borderLeftColor = 'var(--accent-red)';
    } else {
      li.style.borderLeftColor = 'var(--accent-orange)';
    }

    // 提供一個「點擊定位」按鈕
    const highlightButton = w.date 
      ? `<button class="warning-item-highlight-btn" data-date="${w.date}" data-emp="${w.employeeId || ''}">點擊格子定位</button>`
      : '';

    li.innerHTML = `
      <div class="warning-item-desc">${w.message}</div>
      ${highlightButton}
    `;
    list.appendChild(li);
  });

  // 綁定定位按鈕點擊效果 (閃爍定位儲存格)
  document.querySelectorAll('.warning-item-highlight-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const date = this.dataset.date;
      const empId = this.dataset.emp;

      if (!date || !empId) return;

      // 找到對應的 cell-inner
      const cellInner = document.querySelector(`.roster-cell-inner[data-employee-id="${empId}"][data-date="${date}"]`);
      if (cellInner) {
        // 先滾動到該位置
        cellInner.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        
        // 增加發光與抖動動畫 class
        cellInner.style.outline = '3px solid var(--accent-red)';
        cellInner.style.boxShadow = '0 0 20px var(--accent-red)';
        
        setTimeout(() => {
          cellInner.style.outline = '';
          cellInner.style.boxShadow = '';
        }, 1800);
      }
    });
  });
}

// H. 渲染 Dashboard 整體指標 (Metrics Calculations)
function renderGlobalStats() {
  // 1. 人數
  document.getElementById('stat-total-staff').textContent = state.staff.length;

  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);
  const totalEmployees = state.staff.length;
  
  if (totalEmployees === 0) {
    const statCoverage = document.getElementById('stat-coverage');
    if (statCoverage) statCoverage.textContent = '0%';
    const statCoverageText = document.getElementById('stat-coverage-text');
    if (statCoverageText) statCoverageText.textContent = '請先建立人員名單';
    document.getElementById('stat-avg-hours').textContent = '0 hrs';
    const statHoursDesc = document.getElementById('stat-hours-desc');
    if (statHoursDesc) statHoursDesc.textContent = '總工時: 0h';
    return;
  }

  // 2. 人工工時、平均工時與當月假別天數計算
  let totalHours = 0;
  let totalPto = 0;
  let totalAmPto = 0;
  let totalPmPto = 0;
  let totalLoa = 0;

  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    state.staff.forEach(emp => {
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      if (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA') {
        if (shiftId === 'AM_PTO' || shiftId === 'PM_PTO') {
          totalHours += 4;
        } else {
          totalHours += 8;
        }
      }
      
      // 累計各假別次數，後續換算為天數
      if (shiftId === 'PTO') {
        totalPto += 1;
      } else if (shiftId === 'AM_PTO') {
        totalAmPto += 0.5;
      } else if (shiftId === 'PM_PTO') {
        totalPmPto += 0.5;
      } else if (shiftId === 'LOA') {
        totalLoa += 1;
      }
    });
  }

  const avgHours = totalHours / totalEmployees;
  document.getElementById('stat-avg-hours').textContent = `${avgHours.toFixed(1)} hrs`;
  
  const statHoursDesc = document.getElementById('stat-hours-desc');
  if (statHoursDesc) {
    // 依據條件動態組合請假天數描述，若某假別天數為 0 則不顯示
    let desc = `總工時: ${totalHours}h`;
    if (totalPto > 0) desc += ` | 特休: ${totalPto}天`;
    if (totalAmPto > 0) desc += ` | 上特: ${totalAmPto}天`;
    if (totalPmPto > 0) desc += ` | 下特: ${totalPmPto}天`;
    if (totalLoa > 0) desc += ` | LOA: ${totalLoa}天`;
    statHoursDesc.textContent = desc;
  }

  // 3. 今日排班覆蓋率計算
  // 找尋今天(即當月第一天，或目前系統時間的那天。此處簡單採用本月第一天，或 5/22 作為指標)
  const targetDay = Math.min(22, daysCount);
  const targetDateStr = formatDateISO(state.currentYear, state.currentMonth, targetDay);
  const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, targetDay);
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  let requiredToday = 0;
  let scheduledToday = 0;

  state.shifts.forEach(s => {
    const t = state.coverageTargets[s.id] || { weekday: 0, weekend: 0 };
    requiredToday += isWeekend ? t.weekend : t.weekday;
  });

  state.staff.forEach(emp => {
    const shiftId = (state.roster[targetDateStr] && state.roster[targetDateStr][emp.id]) || 'OFF';
    if (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA') {
      if (shiftId === 'AM_PTO' || shiftId === 'PM_PTO') {
        scheduledToday += 0.5;
      } else {
        scheduledToday++;
      }
    }
  });

  const coveragePct = requiredToday > 0 ? Math.min(100, Math.round((scheduledToday / requiredToday) * 100)) : 100;
  const statCoverage = document.getElementById('stat-coverage');
  if (statCoverage) {
    statCoverage.textContent = `${coveragePct}%`;
  }
  const statCoverageText = document.getElementById('stat-coverage-text');
  if (statCoverageText) {
    statCoverageText.textContent = `以 ${targetDay}日為例: 需求 ${requiredToday}人, 實到 ${scheduledToday}人`;
  }
}

// 統整重繪所有 UI 元件
function renderAll() {
  // 更新標題
  const monthNames = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  document.getElementById('roster-calendar-title').textContent = `${state.currentYear} 年 ${monthNames[state.currentMonth]} 月 班表總覽`;

  renderLegend();
  renderRosterGrid();
  renderStaffList();
  renderShiftsList();
  renderFairnessDashboard();
  renderWarningsReport();
  renderGlobalStats();
  updateUnsavedChangesUI(); // 即時更新未儲存變更的 UI 狀態
  updateUndoRedoButtonsUI(); // 即時更新復原/重做按鈕可用狀態
}

// 8. 人員與班別管理底層動作 (Data Actions)

// A. 新增客服人員
  function addStaff(name) {
    const newId = `staff_${Date.now()}`;
  
    const newEmp = {
      id: newId,
      name: name,
      pto: [],
      defaultOffDays: [0, 6],
      defaultWorkShift: 'A',
      sortIndex: state.staff.length // 新增人員排在最後
    };
  
    state.staff.push(newEmp);
    state.hasUnsavedChanges = true;
    rebuildSortedStaffIds();
    renderAll();
  }

// B. 刪除客服人員
function deleteStaff(empId) {
  state.staff = state.staff.filter(emp => emp.id !== empId);
  
  // 刪除其在已發布班表中的記錄
  Object.keys(state.roster).forEach(dateStr => {
    if (state.roster[dateStr][empId]) {
      delete state.roster[dateStr][empId];
    }
  });

  state.hasUnsavedChanges = true;
  rebuildSortedStaffIds();
  renderAll();
}

// C. 新增自訂班別
function addShift(name, start, end) {
  // 以拼音或縮寫產取代碼，此處簡單用 timestamp
  const shiftId = `N${state.shifts.length + 1}`;
  
  const newShift = {
    id: shiftId,
    name: name,
    start: start,
    end: end,
    type: 'custom',
    colorClass: 'custom'
  };

  state.shifts.push(newShift);
  
  // 預設其人力覆蓋目標為 0
  state.coverageTargets[shiftId] = { weekday: 0, weekend: 0 };

  // 偏好已改為休假星期預設，無需更新班次偏好表

  saveToLocalStorage();
  renderAll();
}

// D. 刪除自訂班別
function deleteShift(shiftId) {
  state.shifts = state.shifts.filter(s => s.id !== shiftId);
  delete state.coverageTargets[shiftId];

  // 偏好已改為休假星期預設，無需更新班次偏好表

  // 修改班表中所有已排此班次的人改為休假 (OFF)
  Object.keys(state.roster).forEach(dateStr => {
    Object.keys(state.roster[dateStr]).forEach(empId => {
      if (state.roster[dateStr][empId] === shiftId) {
        state.roster[dateStr][empId] = 'OFF';
      }
    });
  });

  saveToLocalStorage();
  renderAll();
}


// 9. 人員偏好設定與 PTO 編輯 Modal 互動邏輯
let activeConfigEmpId = null;
let tempPtoDays = []; // 暫存特休 YYYY-MM-DD
let tempDefaultOffDays = []; // 暫存休假預設天數 [0-6]

function openEmployeeConfigModal(empId) {
  activeConfigEmpId = empId;
  const emp = state.staff.find(e => e.id === empId);
  if (!emp) return;

  document.getElementById('modal-employee-title').textContent = `編輯 ${emp.name} 的固定休假與指定休假日`;
  
  // 複製一份暫存檔，等按下儲存才套用
  tempPtoDays = [...emp.pto];
  tempDefaultOffDays = [...(emp.defaultOffDays || [])];

  // 1. 渲染 PTO 小型日曆
  renderModalPtoCalendar(emp);

  // 2. 渲染休假預設複選框
  renderModalDefaultOffDays();

  // 3. 填入預設固定班別設定
  document.getElementById('input-emp-default-shift').value = emp.defaultWorkShift || 'A';

  // 顯示 Modal Overlay
  document.getElementById('modal-employee-config').classList.remove('display-none');
}

function renderModalPtoCalendar(emp) {
  const container = document.getElementById('modal-pto-calendar');
  container.innerHTML = '';

  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);
  const firstDayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, 1);

  // 渲染表頭 (星期)
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  weekdays.forEach(w => {
    const header = document.createElement('div');
    header.className = 'modal-cal-day disabled';
    header.style.border = 'none';
    header.innerHTML = `<span class="modal-cal-day-name">${w}</span>`;
    container.appendChild(header);
  });

  // 日曆第一天前的空格填充
  for (let i = 0; i < firstDayOfWeek; i++) {
    const empty = document.createElement('div');
    empty.className = 'modal-cal-day disabled';
    container.appendChild(empty);
  }

  // 渲染 1 至 N 號日期
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    const isSelected = tempPtoDays.includes(dateStr);

    let label = '';
    let cellClass = 'modal-cal-day';
    
    if (isSelected) {
      const leaveType = getLeaveTypeForPtoDay(emp, dateStr, tempPtoDays);
      if (leaveType === 'OFF') {
        label = 'OFF';
        cellClass += ' pto-off-active';
      } else {
        label = '特休';
        cellClass += ' pto-active';
      }
    } else {
      const isDefaultOff = emp.defaultOffDays && emp.defaultOffDays.includes(dayOfWeek);
      if (isDefaultOff) {
        label = '預設';
        cellClass += ' pto-default-off';
      }
    }

    const dayCell = document.createElement('div');
    dayCell.className = cellClass;
    dayCell.dataset.date = dateStr;
    dayCell.innerHTML = `
      <span>${d}</span>
      <span class="modal-cal-day-name">${getDayOfWeekName(dayOfWeek)}</span>
      ${label ? `<span class="modal-cal-day-badge">${label}</span>` : ''}
    `;

    // 點選切換指定休假日狀態並重繪月曆
    dayCell.addEventListener('click', function() {
      const targetDate = this.dataset.date;
      if (tempPtoDays.includes(targetDate)) {
        tempPtoDays = tempPtoDays.filter(x => x !== targetDate);
      } else {
        tempPtoDays.push(targetDate);
      }
      renderModalPtoCalendar(emp);
    });

    container.appendChild(dayCell);
  }
}

function renderModalDefaultOffDays() {
  const container = document.getElementById('default-off-days-checkboxes');
  const warning = document.getElementById('default-off-days-warning');
  if (!container) return;

  container.innerHTML = '';

  const weekdaysName = ['日', '一', '二', '三', '四', '五', '六'];
  
  weekdaysName.forEach((dayName, idx) => {
    const isChecked = tempDefaultOffDays.includes(idx);
    
    // 建立精美的 neomorphic pill/checkbox 按鈕
    const pill = document.createElement('div');
    pill.className = `default-off-day-pill ${isChecked ? 'active' : ''}`;
    pill.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px 16px;
      border-radius: 12px;
      background: ${isChecked ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-card)'};
      color: ${isChecked ? 'var(--accent-blue)' : 'var(--text-secondary)'};
      border: 1px solid ${isChecked ? 'var(--border-color-focus)' : 'var(--border-color)'};
      box-shadow: ${isChecked ? '0 0 8px var(--accent-blue-glow)' : 'var(--shadow-sm)'};
      cursor: pointer;
      font-weight: 600;
      font-size: 0.95rem;
      user-select: none;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      flex: 1;
      min-width: 70px;
      text-align: center;
    `;

    pill.innerHTML = `週${dayName}`;

    // 動態懸停特效
    pill.addEventListener('mouseenter', () => {
      if (!tempDefaultOffDays.includes(idx)) {
        pill.style.background = 'var(--bg-card-hover)';
        pill.style.borderColor = 'rgba(255, 255, 255, 0.15)';
        pill.style.color = 'var(--text-primary)';
      }
    });
    
    pill.addEventListener('mouseleave', () => {
      if (!tempDefaultOffDays.includes(idx)) {
        pill.style.background = 'var(--bg-card)';
        pill.style.borderColor = 'var(--border-color)';
        pill.style.color = 'var(--text-secondary)';
      }
    });

    pill.addEventListener('click', () => {
      const isCurrentlyChecked = tempDefaultOffDays.includes(idx);
      if (isCurrentlyChecked) {
        tempDefaultOffDays = tempDefaultOffDays.filter(x => x !== idx);
      } else {
        tempDefaultOffDays.push(idx);
      }
      
      // 保持排序一致
      tempDefaultOffDays.sort((a, b) => a - b);
      
      // 立即重新渲染樣式與警示
      renderModalDefaultOffDays();
    });

    container.appendChild(pill);
  });

  // 判斷是否非剛好 2 天則顯示警告
  if (tempDefaultOffDays.length !== 2) {
    warning.style.display = 'block';
  } else {
    warning.style.display = 'none';
  }
}

function saveEmployeeConfig() {
  if (!activeConfigEmpId) return;
  
  const empIndex = state.staff.findIndex(e => e.id === activeConfigEmpId);
  if (empIndex === -1) return;

  // 取得舊的 pto 列表以便比對哪些被移除了
  const oldPto = state.staff[empIndex].pto || [];

  // 套用暫存與輸入變數
  state.staff[empIndex].pto = tempPtoDays;
  state.staff[empIndex].defaultOffDays = tempDefaultOffDays;
  state.staff[empIndex].defaultWorkShift = document.getElementById('input-emp-default-shift').value || 'A';

  // 更新排程中的假期狀態
  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    if (state.roster[dateStr]) {
      const isSelected = tempPtoDays.includes(dateStr);
      if (isSelected) {
        // 被選中：依據新規則設定為 OFF 或 PTO
        const leaveType = getLeaveTypeForPtoDay(state.staff[empIndex], dateStr, tempPtoDays);
        state.roster[dateStr][activeConfigEmpId] = leaveType;
      } else {
        // 未被選中：如果以前是選中的指定休假日 (在 oldPto 中)，現在被取消了，改回預設班別 (若是固定休假日則改回 OFF)
        if (oldPto.includes(dateStr)) {
          const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
          const isDefaultOff = tempDefaultOffDays.includes(dayOfWeek);
          state.roster[dateStr][activeConfigEmpId] = isDefaultOff ? 'OFF' : (state.staff[empIndex].defaultWorkShift || 'A');
        }
      }
    }
  }

  state.hasUnsavedChanges = true;
  rebuildSortedStaffIds();
  closeEmployeeConfigModal();
  renderAll();
}

function closeEmployeeConfigModal() {
  activeConfigEmpId = null;
  document.getElementById('modal-employee-config').classList.add('display-none');
}


// 10. 匯出功能 (CSV & JSON & Print Layout PDF)

// A. 匯出 CSV 班表 (針對 Excel 支援，強制加入 UTF-8 BOM \ufeff 避免亂碼)
function exportRosterToCSV() {
  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);
  const staffList = state.staff;
  const shiftList = state.shifts;
  const shiftMap = new Map(shiftList.map(s => [s.id, s.name]));
  shiftMap.set('OFF', '休假');
  shiftMap.set('PTO', '特休');

  let csvContent = '\ufeff'; // Excel 繁體中文 UTF-8 BOM 識別碼
  
  // 1. 寫入第一列表頭
  const header = ['客服人員 / 日期'];
  for (let d = 1; d <= daysCount; d++) {
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    header.push(`${d}日(${getDayOfWeekName(dayOfWeek)})`);
  }
  csvContent += header.join(',') + '\n';

  // 2. 寫入各客服排班資料
  staffList.forEach(emp => {
    const row = [emp.name];
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const sId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      row.push(shiftMap.get(sId) || sId);
    }
    csvContent += row.join(',') + '\n';
  });

  // 3. 寫入每日可額外休假 (PTO) 額度列
  const ptoRow = ['可再休 PTO'];
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    // 計算當日最低人力需求 (所有班次的目標之和)
    let minRequired = 0;
    shiftList.forEach(s => {
      const targetConfig = state.coverageTargets[s.id] || { weekday: 0, weekend: 0 };
      minRequired += isWeekend ? targetConfig.weekend : targetConfig.weekday;
    });

    // 計算當日已排班人數 (非 OFF/PTO/LOA，且排除獨立班D)
    let activeWorking = 0;
    staffList.forEach(emp => {
      if (emp.defaultWorkShift === 'D') return;
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      if (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA') {
        if (shiftId === 'AM_PTO' || shiftId === 'PM_PTO') {
          activeWorking += 0.5;
        } else {
          activeWorking++;
        }
      }
    });

    // 額外可休額度 = 已排班人數 - 最低人力需求
    const extraPtoAvailable = Math.max(0, activeWorking - minRequired);
    const quotaLabel = extraPtoAvailable > 0 ? `+${extraPtoAvailable}` : '0';
    ptoRow.push(quotaLabel);
  }
  csvContent += ptoRow.join(',') + '\n';

  try {
    // 4. 下載觸發
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Asurion客服排班表_${state.currentYear}年_${state.currentMonth + 1}月.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("自動下載 CSV 被阻擋，啟用備用彈窗:", err);
    showExportFallback(csvContent, 'CSV');
  }
}

// B. 備份排班設定為 JSON 檔案
function exportRosterToJSON() {
  const jsonContent = JSON.stringify(state, null, 2);
  try {
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Asurion排班備份_${state.currentYear}_${state.currentMonth + 1}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("自動下載 JSON 被阻擋，啟用備用彈窗:", err);
    showExportFallback(jsonContent, 'JSON');
  }
}

// C. 顯示備用複製彈窗
function showExportFallback(content, formatType) {
  const modal = document.getElementById('modal-export-fallback');
  const textarea = document.getElementById('export-fallback-textarea');
  textarea.value = content;
  modal.classList.remove('display-none');
  
  const copyBtn = document.getElementById('btn-export-copy');
  const originalText = copyBtn.textContent;
  
  copyBtn.onclick = function() {
    textarea.select();
    navigator.clipboard.writeText(content).then(() => {
      copyBtn.textContent = '✅ 已複製到剪貼簿！';
      setTimeout(() => {
        copyBtn.textContent = originalText;
      }, 2000);
    }).catch(err => {
      alert('自動複製失敗，請手動按 Ctrl+C 複製框內文字！');
    });
  };
}

// C. 匯入備份 JSON 設定檔
function importRosterFromJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const parsed = JSON.parse(e.target.result);
      if (parsed.staff && parsed.shifts && parsed.coverageTargets) {
        state.currentYear = parsed.currentYear || 2026;
        state.currentMonth = parsed.currentMonth !== undefined ? parsed.currentMonth : 4;
        state.monthlyDaysOff = parsed.monthlyDaysOff || {};
        updateDaysOffFromState();
        state.staff = parsed.staff;
        state.shifts = parsed.shifts;
        state.coverageTargets = parsed.coverageTargets;
        state.roster = parsed.roster || {};
        
        saveToLocalStorage();
        populateYearMonthSelectors();
        renderAll();
        alert('排班資料設定已成功匯入！');
      } else {
        alert('匯入失敗：這不是格式正確的排班設定備份檔案。');
      }
    } catch (err) {
      alert('解析 JSON 檔案時出錯：' + err.message);
    }
  };
  reader.readAsText(file);
}


// 10.5. 儲存/取消變更機制與 Google Sheets 後端同步 (Phase 2)

// 更新未儲存變更 UI
function updateUnsavedChangesUI() {
  const unsavedBanner = document.getElementById('roster-unsaved-actions');
  const statusBadge = document.getElementById('roster-status-badge');
  
  if (unsavedBanner) {
    if (state.hasUnsavedChanges) {
      unsavedBanner.classList.remove('display-none');
    } else {
      unsavedBanner.classList.add('display-none');
    }
  }
  
  if (statusBadge) {
    if (state.hasUnsavedChanges) {
      statusBadge.textContent = '有未儲存的變更';
      statusBadge.style.background = 'var(--accent-orange)';
      statusBadge.style.color = '#fff';
      statusBadge.style.boxShadow = '0 0 10px rgba(249, 115, 22, 0.4)';
    } else {
      const hasData = Object.keys(state.roster).length > 0;
      statusBadge.textContent = hasData ? '已發布' : '未發布';
      statusBadge.style.background = hasData ? 'var(--accent-blue)' : 'var(--text-muted)';
      statusBadge.style.color = '#fff';
      statusBadge.style.boxShadow = 'none';
    }
  }
}

// 儲存所有變更 (包含班表與客服名單)
function saveRosterChanges() {
  state.backupRoster = JSON.parse(JSON.stringify(state.roster));
  state.backupStaff = JSON.parse(JSON.stringify(state.staff));
  state.hasUnsavedChanges = false;
  state.manualEdits = {}; // 儲存後清空手動編輯標記
  saveToLocalStorage();
  updateUnsavedChangesUI();
  
  if (state.googleWebAppUrl) {
    syncRosterToCloud(true); // 靜默上傳
  }
  
  alert('班表已成功儲存！');
  rebuildSortedStaffIds();
  renderAll(); // 重繪以清除儲存格的修改亮框
}

// 取消所有變更
function cancelRosterChanges() {
  if (confirm('確定要取消所有未儲存的變更嗎？此動作將還原為上一次儲存的班表與人員設定狀態。')) {
    state.roster = JSON.parse(JSON.stringify(state.backupRoster || {}));
    state.staff = JSON.parse(JSON.stringify(state.backupStaff || []));
    state.hasUnsavedChanges = false;
    state.manualEdits = {}; // 取消後清空手動編輯標記
    rebuildSortedStaffIds();
    renderAll();
    updateUnsavedChangesUI();
  }
}

// 輔助函式：更新雲端同步狀態卡片
function updateSyncStatus(status, label, color, lastTime = null, message = null) {
  const indicator = document.getElementById('sync-status-indicator');
  const lastTimeSpan = document.getElementById('sync-last-time');
  const messageDiv = document.getElementById('sync-status-message');
  
  if (indicator) {
    indicator.textContent = label;
    indicator.style.color = color;
    indicator.className = `status-value ${status}`;
  }
  
  if (lastTimeSpan) {
    if (lastTime) {
      lastTimeSpan.textContent = lastTime;
    } else {
      const savedLastTime = localStorage.getItem('aura_roster_last_sync');
      lastTimeSpan.textContent = savedLastTime || '-';
    }
  }
  
  if (messageDiv && message !== null) {
    messageDiv.textContent = message;
  }
}

// 備份到雲端 (POST)
async function syncRosterToCloud(isAuto = false) {
  const url = state.googleWebAppUrl;
  if (!url) {
    if (!isAuto) {
      alert('尚未配置雲端同步網址！');
    }
    return;
  }
  
  updateSyncStatus('connecting', '同步中...', 'var(--accent-orange)');
  
  try {
    const payload = JSON.stringify(state);
    
    // 使用 text/plain 避免 OPTIONS 預檢請求 (CORS 解決方案)
    const response = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: payload
    });
    
    if (!response.ok) {
      throw new Error(`HTTP 錯誤! 狀態碼: ${response.status}`);
    }
    
    const result = await response.json();
    if (result.success) {
      const nowStr = new Date().toLocaleString();
      localStorage.setItem('aura_roster_last_sync', nowStr);
      
      updateSyncStatus('connected', '已連接', 'var(--accent-green)', nowStr, result.message || '資料已成功備份至 Google Sheets！');
      
      if (!isAuto) {
        alert(result.message || '雲端同步成功！已在 Google Sheets 中產生精美班表。');
      }
    } else {
      throw new Error(result.message || 'Google Sheets 寫入失敗');
    }
  } catch (err) {
    console.error("雲端上傳失敗:", err);
    updateSyncStatus('disconnected', '連線失敗', 'var(--accent-red)', null, `同步失敗: ${err.message}`);
    if (!isAuto) {
      alert(`雲端備份失敗：${err.message}\n請檢查網址是否正確，且 Apps Script 部署設定為「任何人 (Anyone)」存取。`);
    }
  }
}

// 從雲端同步 (GET)
async function syncRosterFromCloud(isSilent = false) {
  const url = state.googleWebAppUrl;
  if (!url) {
    if (!isSilent) {
      alert('尚未配置雲端同步網址！');
    }
    return;
  }
  
  if (state.hasUnsavedChanges && !isSilent) {
    const confirmDiscard = confirm('您有未儲存的變更！從雲端同步會覆蓋目前的所有變更，確定要繼續嗎？');
    if (!confirmDiscard) return;
  }
  
  updateSyncStatus('connecting', '同步中...', 'var(--accent-orange)');
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors'
    });
    
    if (!response.ok) {
      throw new Error(`HTTP 錯誤! 狀態碼: ${response.status}`);
    }
    
    const cloudState = await response.json();
    
    if (cloudState && cloudState.staff && cloudState.shifts) {
      state.currentYear = cloudState.currentYear || 2026;
      state.currentMonth = cloudState.currentMonth !== undefined ? cloudState.currentMonth : 4;
      state.monthlyDaysOff = cloudState.monthlyDaysOff || {};
      updateDaysOffFromState();
      state.staff = cloudState.staff;
      state.shifts = cloudState.shifts;
      state.coverageTargets = cloudState.coverageTargets || {};
      state.roster = cloudState.roster || {};
      state.theme = cloudState.theme || 'dark';
      
      // 自動升級雲端資料：若缺少 sortIndex，依陣列順序自動指派
      state.staff.forEach((emp, idx) => {
        if (emp.sortIndex === undefined || emp.sortIndex === null) {
          emp.sortIndex = idx;
        }
      });
      
      state.backupRoster = JSON.parse(JSON.stringify(state.roster));
      state.backupStaff = JSON.parse(JSON.stringify(state.staff));
      state.manualEdits = {};
      state.hasUnsavedChanges = false;
      
      saveToLocalStorage();
      sortStaffByShift(); // 依 sortIndex 穩定排序
      rebuildSortedStaffIds(); // 重建排序
      
      populateYearMonthSelectors();
      renderAll();
      updateUnsavedChangesUI();
      
      const nowStr = new Date().toLocaleString();
      localStorage.setItem('aura_roster_last_sync', nowStr);
      
      updateSyncStatus('connected', '已連接', 'var(--accent-green)', nowStr, '已成功從 Google Sheets 同步最新狀態！');
      if (!isSilent) {
        alert('已成功從雲端同步最新班表與設定！');
      }
    } else {
      throw new Error('雲端返回的資料結構不正確或為空（請先執行一次「備份到雲端」以寫入初始狀態）。');
    }
  } catch (err) {
    console.error("雲端下載失敗:", err);
    updateSyncStatus('disconnected', '連線失敗', 'var(--accent-red)', null, `下載失敗: ${err.message}`);
    if (!isSilent) {
      alert(`從雲端同步失敗：${err.message}\n請確認雲端是否有備份資料，且 Apps Script 部署設定正確。`);
    }
  }
}

// 10.8. 歷史班表完全移除


// A.2 匯出 Excel 班表 (輸出為相容 Excel 的 HTML 格式以支援背景顏色、合併儲存格與字型樣式)
function exportRosterToExcel() {
  const daysCount = getDaysInMonth(state.currentYear, state.currentMonth);
  const staffList = state.staff;
  const shiftList = state.shifts;
  
  const sortedStaff = getSortedStaffForOverview(staffList);

  const monthEng = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][state.currentMonth];
  const standardOff = state.daysOff;
  const standardWork = daysCount - standardOff;

  // 輔助函數：取得員工輪流的用餐時間 (依班別順序交錯)
  function getEmployeeLunchTime(emp, sortedList) {
    const sameShiftStaff = sortedList.filter(e => e.defaultWorkShift === emp.defaultWorkShift);
    const idx = sameShiftStaff.findIndex(e => e.id === emp.id);
    const shiftId = emp.defaultWorkShift || 'A';
    
    const lunchTimes = {
      A: ['12:00', '11:00', '11:30', '12:30'],
      B: ['15:00', '16:00', '15:30', '16:30'],
      C: ['18:00', '19:00', '18:30', '17:30'],
      D: ['17:00', '16:00', '16:30', '17:30']
    };
    
    const list = lunchTimes[shiftId] || lunchTimes['A'];
    return list[idx % list.length];
  }

  // 輔助函數：取得班別儲存格樣式
  function getShiftCellStyle(shiftId) {
    if (shiftId === 'OFF') {
      return { bg: '#FFF2CC', text: '#000000', label: 'OFF' };
    }
    if (shiftId === 'PTO') {
      return { bg: '#FCE4D6', text: '#FF0000', label: 'PTO' };
    }
    if (shiftId === 'LOA') {
      return { bg: '#E2E8F0', text: '#000000', label: 'LOA' };
    }
    if (shiftId === 'AM_PTO' || shiftId === 'PM_PTO') {
      return { bg: '#FFF2CC', text: '#FF0000', label: 'PTO-Half' };
    }
    
    const matchedShift = shiftList.find(s => s.id === shiftId);
    const label = matchedShift ? matchedShift.start : shiftId;
    
    if (shiftId === 'A') return { bg: '#D9E1F2', text: '#000000', label };
    if (shiftId === 'B') return { bg: '#E2EFDA', text: '#000000', label };
    if (shiftId === 'C') return { bg: '#F2DBDB', text: '#000000', label };
    if (shiftId === 'D') return { bg: '#FDE9D9', text: '#000000', label };
    
    return { bg: '#FDE9D9', text: '#000000', label };
  }

  const groupColors = { A: '#B4C6E7', B: '#C6E0B4', C: '#F2DBDB', D: '#F8CBAD' };
  const weekdaysEng = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdayMap = ['日', '一', '二', '三', '四', '五', '六'];

  // 開始組裝 Excel HTML Table 内容
  let html = `
<html xmlns:o="urn:schemas-microsoft-excel:office:office" xmlns:x="urn:schemas-microsoft-excel:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<!--[if gte mso 9]>
<xml>
  <x:ExcelWorkbook>
    <x:ExcelWorksheets>
      <x:ExcelWorksheet>
        <x:Name>客服班表</x:Name>
        <x:WorksheetOptions>
          <x:DisplayGridlines/>
        </x:WorksheetOptions>
      </x:ExcelWorksheet>
    </x:ExcelWorksheets>
  </x:ExcelWorkbook>
</xml>
<![endif]-->
<style>
  table { border-collapse: collapse; }
  td, th { border: 1px solid #7F7F7F; text-align: center; font-family: "Microsoft JhengHei", Arial, sans-serif; font-size: 10pt; height: 24px; vertical-align: middle; }
  .header-cell { background-color: #F2F2F2; font-weight: bold; }
  .sun-cell { color: #FF0000; }
  .ot-cell { text-align: center; font-weight: bold; background-color: #F2F2F2; }
  .comment-cell { background-color: #FFFFFF; }
</style>
</head>
<body>
  <table>
    <!-- 1. 表頭第一列 -->
    <tr>
      <th rowspan="2" class="header-cell" style="width: 120px;">${state.currentYear}</th>
      <th class="header-cell" style="width: 100px;">${monthEng}</th>
      <th class="header-cell" style="width: 60px;">休假</th>
      <th rowspan="2" class="header-cell" style="width: 70px;">用餐</th>
      <th rowspan="2" class="header-cell" style="width: 70px;">工作日</th>
      <th rowspan="2" class="header-cell" style="width: 60px;">OFF</th>
      <th rowspan="2" class="header-cell" style="width: 60px;">PTO</th>
      <th rowspan="2" class="header-cell" style="width: 70px;">PTO-AL</th>
      <th rowspan="2" class="header-cell" style="width: 60px;">LOA</th>
  `;

  // 填充表頭第一列的星期
  for (let d = 1; d <= daysCount; d++) {
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    const isSun = (dayOfWeek === 0);
    const sunStyle = isSun ? ' color: #FF0000;' : '';
    html += `      <th class="header-cell" style="width: 65px;${sunStyle}">${weekdaysEng[dayOfWeek]}</th>\n`;
  }
  html += `    </tr>\n`;

  // 2. 表頭第二列
  html += `    <tr>
      <th class="header-cell">${standardWork}</th>
      <th class="header-cell">${standardOff}</th>
  `;
  for (let d = 1; d <= daysCount; d++) {
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    const isSun = (dayOfWeek === 0);
    const sunStyle = isSun ? ' color: #FF0000;' : '';
    html += `      <th class="header-cell" style="${sunStyle}">${d}-${monthEng}</th>\n`;
  }
  html += `    </tr>\n`;

  // 3. 寫入各客服排班資料
  sortedStaff.forEach(emp => {
    const color = groupColors[emp.defaultWorkShift] || '#FFFFFF';
    const defShift = shiftList.find(s => s.id === emp.defaultWorkShift);
    const shiftHours = defShift ? `${defShift.start}-${defShift.end}` : '';
    const fixedOffStr = emp.defaultOffDays ? emp.defaultOffDays.map(d => weekdayMap[d]).join('') : '';
    const lunchTime = getEmployeeLunchTime(emp, sortedStaff);

    // 計算各項假別天數
    let workCount = 0;
    let offCount = 0;
    let ptoCount = 0;
    let loaCount = 0;

    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const sId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      
      if (sId === 'OFF') {
        offCount++;
      } else if (sId === 'PTO') {
        ptoCount++;
      } else if (sId === 'LOA') {
        loaCount++;
      } else if (sId === 'AM_PTO' || sId === 'PM_PTO') {
        ptoCount += 0.5;
        workCount += 0.5;
      } else {
        workCount++;
      }
    }

    // 員工第一列 (排班資料)
    html += `    <tr>
      <td rowspan="2" style="background-color: ${color}; font-weight: bold;">${emp.name}</td>
      <td rowspan="2" style="background-color: ${color};">${shiftHours}</td>
      <td rowspan="2" style="background-color: ${color};">${fixedOffStr}</td>
      <td rowspan="2" style="background-color: ${color};">${lunchTime}</td>
      <td style="background-color: ${color}; font-weight: bold;">${workCount}</td>
      <td style="background-color: ${color}; font-weight: bold;">${offCount}</td>
      <td style="background-color: ${color}; font-weight: bold;">${ptoCount}</td>
      <td style="background-color: ${color}; font-weight: bold;">0</td>
      <td style="background-color: ${color}; font-weight: bold;">${loaCount}</td>
    `;

    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const sId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      const cellInfo = getShiftCellStyle(sId);
      const styleStr = `background-color: ${cellInfo.bg}; color: ${cellInfo.text};${cellInfo.text === '#FF0000' ? ' font-weight: bold;' : ''}`;
      html += `      <td style="${styleStr}">${cellInfo.label}</td>\n`;
    }
    html += `    </tr>\n`;

    // 員工第二列 (備註與 OT)
    html += `    <tr>
      <td colspan="5" class="ot-cell" style="background-color: ${color};">OT</td>
    `;
    for (let d = 1; d <= daysCount; d++) {
      html += `      <td class="comment-cell"></td>\n`;
    }
    html += `    </tr>\n`;
  });

  // 4. 寫入每日可額外休假 (PTO) 額度列
  html += `    <tr>
      <td colspan="9" class="header-cell" style="text-align: right; font-weight: bold; padding-right: 10px;">可再休 PTO</td>
  `;
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    const dayOfWeek = getDayOfWeek(state.currentYear, state.currentMonth, d);
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    let minRequired = 0;
    shiftList.forEach(s => {
      const targetConfig = state.coverageTargets[s.id] || { weekday: 0, weekend: 0 };
      minRequired += isWeekend ? targetConfig.weekend : targetConfig.weekday;
    });

    let activeWorking = 0;
    staffList.forEach(emp => {
      if (emp.defaultWorkShift === 'D') return;
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      if (shiftId !== 'OFF' && shiftId !== 'PTO' && shiftId !== 'LOA') {
        if (shiftId === 'AM_PTO' || shiftId === 'PM_PTO') {
          activeWorking += 0.5;
        } else {
          activeWorking++;
        }
      }
    });

    const extraPtoAvailable = Math.max(0, activeWorking - minRequired);
    const quotaLabel = extraPtoAvailable > 0 ? `+${extraPtoAvailable}` : '0';
    html += `      <td class="header-cell" style="font-weight: bold;">${quotaLabel}</td>\n`;
  }
  html += `    </tr>\n`;

  html += `  </table>
</body>
</html>`;

  try {
    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Asurion客服班表_${state.currentYear}年_${state.currentMonth + 1}月.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("自動下載 Excel 被阻擋，啟用備用彈窗:", err);
    showExportFallback(html, 'Excel');
  }
}

// A.3 智慧排班與手動調整之復原與重做 (Undo / Redo 邏輯)
function pushUndoState() {
  // 複製一份當前的 roster 狀態與手動編輯狀態並推入 undoStack
  const rosterCopy = JSON.parse(JSON.stringify(state.roster));
  const manualEditsCopy = JSON.parse(JSON.stringify(state.manualEdits || {}));
  undoStack.push({ roster: rosterCopy, manualEdits: manualEditsCopy });
  
  // 限制 stack 大小 (例如最多 50 步)
  if (undoStack.length > 50) {
    undoStack.shift();
  }
  
  // 有新的變更動作時，清空重做 stack
  redoStack = [];
  updateUndoRedoButtonsUI();
}

function undoRoster() {
  if (undoStack.length === 0) return;
  // 備份當前狀態到 redoStack
  const currentRoster = JSON.parse(JSON.stringify(state.roster));
  const currentEdits = JSON.parse(JSON.stringify(state.manualEdits || {}));
  redoStack.push({ roster: currentRoster, manualEdits: currentEdits });
  
  // 載入上一步
  const popped = undoStack.pop();
  if (popped && popped.roster) {
    state.roster = popped.roster;
    state.manualEdits = popped.manualEdits || {};
  } else {
    state.roster = popped || {};
    state.manualEdits = {};
  }
  state.hasUnsavedChanges = true;
  updateUnsavedChangesUI();
  updateUndoRedoButtonsUI();
  renderAll();
}

function redoRoster() {
  if (redoStack.length === 0) return;
  // 備份當前狀態到 undoStack
  const currentRoster = JSON.parse(JSON.stringify(state.roster));
  const currentEdits = JSON.parse(JSON.stringify(state.manualEdits || {}));
  undoStack.push({ roster: currentRoster, manualEdits: currentEdits });
  
  // 載入下一步
  const popped = redoStack.pop();
  if (popped && popped.roster) {
    state.roster = popped.roster;
    state.manualEdits = popped.manualEdits || {};
  } else {
    state.roster = popped || {};
    state.manualEdits = {};
  }
  state.hasUnsavedChanges = true;
  updateUnsavedChangesUI();
  updateUndoRedoButtonsUI();
  renderAll();
}

function updateUndoRedoButtonsUI() {
  const btnUndo = document.getElementById('btn-undo-roster');
  const btnRedo = document.getElementById('btn-redo-roster');
  if (btnUndo) {
    btnUndo.disabled = (undoStack.length === 0);
  }
  if (btnRedo) {
    btnRedo.disabled = (redoStack.length === 0);
  }
}

// 11. 事件監聽與 DOM 初始化 (Event Bindings)
document.addEventListener('DOMContentLoaded', () => {
  
  // 1. 初始化資料庫與狀態
  initDatabase();
  populateYearMonthSelectors();
  updateDaysOffFromState();

  // 偵測到配置的雲端同步網址，正在自動載入最新雲端班表與歷史封存...
  if (state.googleWebAppUrl) {
    console.log("偵測到配置的雲端同步網址，正在自動載入最新雲端班表與歷史封存...");
    setTimeout(() => {
      syncRosterFromCloud(true);
    }, 500);
  }

  // 2. 年月/天數變動重繪監聽
  const yearSelect = document.getElementById('schedule-year');
  const monthSelect = document.getElementById('schedule-month');
  const daysOffInput = document.getElementById('global-days-off');

  yearSelect.addEventListener('change', function() {
    state.currentYear = parseInt(this.value);
    updateDaysOffFromState();
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtonsUI();
    saveToLocalStorage();
    rebuildSortedStaffIds();
    renderAll();
  });

  monthSelect.addEventListener('change', function() {
    state.currentMonth = parseInt(this.value);
    updateDaysOffFromState();
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtonsUI();
    saveToLocalStorage();
    rebuildSortedStaffIds();
    renderAll();
  });

  daysOffInput.addEventListener('change', function() {
    const val = Math.max(4, Math.min(15, parseInt(this.value) || 8));
    state.daysOff = val;
    if (!state.monthlyDaysOff) {
      state.monthlyDaysOff = {};
    }
    const key = `${state.currentYear}-${state.currentMonth}`;
    state.monthlyDaysOff[key] = val;
    saveToLocalStorage();
    rebuildSortedStaffIds();
    renderAll();
  });

  // 3. 側邊欄 Tab 切換事件
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', function() {
      // 移除其他 active Tab
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));

      // 啟用當前 Tab
      this.classList.add('active');
      const targetId = this.dataset.tab;
      document.getElementById(targetId).classList.add('active');
    });
  });

  // 4. 深淺色主題切換按鈕
  document.getElementById('btn-theme-toggle').addEventListener('click', () => {
    const newTheme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
    saveToLocalStorage();
  });

  // 5. 客服人員面板操作事件
  const addStaffBtn = document.getElementById('btn-add-staff');
  const addStaffForm = document.getElementById('add-staff-form');
  const staffCancelBtn = document.getElementById('btn-staff-cancel');
  const staffSubmitBtn = document.getElementById('btn-staff-submit');
  const staffNameInput = document.getElementById('input-staff-name');

  addStaffBtn.addEventListener('click', () => {
    addStaffForm.classList.remove('display-none');
    staffNameInput.focus();
  });

  staffCancelBtn.addEventListener('click', () => {
    addStaffForm.classList.add('display-none');
    staffNameInput.value = '';
  });

  staffSubmitBtn.addEventListener('click', () => {
    const name = staffNameInput.value.trim();
    if (!name) {
      alert('請輸入客服人員姓名！');
      return;
    }
    addStaff(name);
    addStaffForm.classList.add('display-none');
    staffNameInput.value = '';
  });


  // 7. 一鍵自動排班按鈕事件
  document.getElementById('btn-auto-schedule').addEventListener('click', function() {
    if (state.staff.length === 0) {
      alert('請先在左側新增至少一位客服人員！');
      return;
    }

    // 保存當前狀態以利復原
    pushUndoState();

    // 執行自動排班時，重設手動編輯狀態
    state.manualEdits = {};

    const btn = this;
    const originalText = btn.innerHTML;
    
    // 排班中微動畫與按鈕停用
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="btn-icon-svg animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
      <span>AI 引擎規劃中...</span>
    `;

    setTimeout(() => {
      runAutoScheduler();
      renderAll();
      
      btn.disabled = false;
      btn.innerHTML = originalText;
      
      // 成功氣泡提示
      alert('排班引擎已成功自動規劃，已盡最大可能符合勞基法合規與員工排班喜好！');
    }, 600); // 微量的視覺延遲模擬高級計算
  });

  // 8. 衝突警告面版收合按鈕
  document.getElementById('btn-dismiss-warnings').addEventListener('click', () => {
    document.getElementById('warnings-panel').classList.add('display-none');
  });

  // 9. Modal 關閉/儲存按鈕
  document.getElementById('btn-close-modal').addEventListener('click', closeEmployeeConfigModal);
  document.getElementById('btn-pref-cancel').addEventListener('click', closeEmployeeConfigModal);
  document.getElementById('btn-pref-save').addEventListener('click', saveEmployeeConfig);

  // 備用複製彈窗關閉按鈕
  const closeExportModal = () => {
    document.getElementById('modal-export-fallback').classList.add('display-none');
  };
  document.getElementById('btn-close-export-modal').addEventListener('click', closeExportModal);
  document.getElementById('btn-export-close').addEventListener('click', closeExportModal);

  // 10. 匯出班表事件 (直接由按鈕匯出 Excel)
  const exportBtn = document.getElementById('btn-export-roster');
  if (exportBtn) {
    exportBtn.addEventListener('click', (e) => {
      e.preventDefault();
      exportRosterToExcel();
    });
  }

  // 放大/還原視窗檢視
  const btnMaximize = document.getElementById('btn-maximize-roster');
  if (btnMaximize) {
    btnMaximize.addEventListener('click', (e) => {
      e.preventDefault();
      const container = document.querySelector('.roster-view-container');
      const isFullscreen = container.classList.toggle('roster-fullscreen');
      if (isFullscreen) {
        btnMaximize.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px;">
            <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>
          </svg>
          <span>還原視窗</span>
        `;
        btnMaximize.title = "還原視窗";
        document.body.style.overflow = 'hidden'; // 避免背景網頁捲動
      } else {
        btnMaximize.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px;">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
          <span>放大檢視</span>
        `;
        btnMaximize.title = "放大檢視";
        document.body.style.overflow = '';
      }
    });
  }

  // 監聽 Escape 鍵退出放大檢視
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const container = document.querySelector('.roster-view-container');
      if (container && container.classList.contains('roster-fullscreen')) {
        container.classList.remove('roster-fullscreen');
        if (btnMaximize) {
          btnMaximize.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px;">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
            </svg>
            <span>放大檢視</span>
          `;
          btnMaximize.title = "放大檢視";
        }
        document.body.style.overflow = '';
      }
    }
  });



  // 10.2 復原與重做按鈕事件
  const btnUndo = document.getElementById('btn-undo-roster');
  if (btnUndo) {
    btnUndo.addEventListener('click', (e) => {
      e.preventDefault();
      undoRoster();
    });
  }

  const btnRedo = document.getElementById('btn-redo-roster');
  if (btnRedo) {
    btnRedo.addEventListener('click', (e) => {
      e.preventDefault();
      redoRoster();
    });
  }

  // 儲存/取消按鈕
  const btnSaveRoster = document.getElementById('btn-save-roster');
  const btnCancelRoster = document.getElementById('btn-cancel-roster');
  
  if (btnSaveRoster) {
    btnSaveRoster.addEventListener('click', saveRosterChanges);
  }
  
  if (btnCancelRoster) {
    btnCancelRoster.addEventListener('click', cancelRosterChanges);
  }

  // 10.3 備忘錄儲存與初始化
  initMemos();
  setupMemoEventListeners();

  // 11. 首次繪製
  renderAll();
});

function initMemos() {
  const memoVal = localStorage.getItem('aura_roster_memo') || '';
  const textarea = document.getElementById('memo-content');
  if (textarea) textarea.value = memoVal;
}

function setupMemoEventListeners() {
  const btnSave = document.getElementById('btn-save-memo');
  const textarea = document.getElementById('memo-content');
  const btnMaximize = document.getElementById('btn-maximize-memo');
  const memoCard = document.querySelector('.metric-card.memo-card');
  
  if (btnSave && textarea) {
    btnSave.addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.setItem('aura_roster_memo', textarea.value);
      showMemoSaveFeedback(btnSave);
    });
  }
  
  if (btnMaximize && memoCard) {
    btnMaximize.addEventListener('click', (e) => {
      e.preventDefault();
      const isFullscreen = memoCard.classList.toggle('memo-fullscreen');
      if (isFullscreen) {
        btnMaximize.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="memo-btn-icon">
            <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>
          </svg>
          <span>還原視窗</span>
        `;
        btnMaximize.title = "還原視窗";
        document.body.style.overflow = 'hidden'; // 避免背景網頁捲動
      } else {
        btnMaximize.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="memo-btn-icon">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
          <span>放大檢視</span>
        `;
        btnMaximize.title = "放大檢視";
        document.body.style.overflow = '';
      }
    });

    // 監聽 Escape 鍵退出備忘錄放大檢視
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && memoCard.classList.contains('memo-fullscreen')) {
        memoCard.classList.remove('memo-fullscreen');
        btnMaximize.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="memo-btn-icon">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
          <span>放大檢視</span>
        `;
        btnMaximize.title = "放大檢視";
        document.body.style.overflow = '';
      }
    });
  }
}

function showMemoSaveFeedback(btn) {
  const originalText = btn.innerHTML;
  btn.innerHTML = '✓ 已儲存';
  btn.style.background = 'var(--accent-green)';
  btn.style.borderColor = 'var(--accent-green)';
  btn.style.boxShadow = '0 0 10px var(--accent-green-glow)';
  btn.disabled = true;
  
  setTimeout(() => {
    btn.innerHTML = originalText;
    btn.style.background = '';
    btn.style.borderColor = '';
    btn.style.boxShadow = '';
    btn.disabled = false;
  }, 1500);
}
