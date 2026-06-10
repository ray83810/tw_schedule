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
  backupRoster: {}          // 保存上次儲存的班表備份以供「取消變更」復原
};

let dragSrcEl = null;

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
  state.daysOff = 8;
  state.staff = JSON.parse(JSON.stringify(DEFAULT_STAFF));
  sortStaffByShift();
  state.shifts = JSON.parse(JSON.stringify(DEFAULT_SHIFTS));
  state.coverageTargets = JSON.parse(JSON.stringify(DEFAULT_COVERAGE));
  state.roster = {}; // 預設空班表
  state.googleWebAppUrl = 'https://script.google.com/macros/s/AKfycbzv05O95bIipY0MqRX-9gyP-VCP9GRfvAHLpSorDZNdvIGzmolQYPEvGFus7y5UDPfV/exec';
  state.backupRoster = {};
  state.backupStaff = JSON.parse(JSON.stringify(state.staff));
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
    
    const isWork = (shiftId !== 'OFF' && shiftId !== 'PTO');
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
  shiftMap.set('LOA', { id: 'LOA', name: '留職停薪', start: '00:00', end: '00:00' });
  shiftMap.set('AM_PTO', { id: 'AM_PTO', name: '上午特休', start: '00:00', end: '00:00' });
  shiftMap.set('PM_PTO', { id: 'PM_PTO', name: '下午特休', start: '00:00', end: '00:00' });

  // 一、針對每位客服人員的個人檢查 (7休1、11小時輪班間隔、每月休天數)
  state.staff.forEach(employee => {
    // 智慧跨月邊界歷史追溯檢查
    const boundary = getPreviousMonthBoundaryStats(employee.id, year, month);
    let consecutiveWorkDays = boundary.consecutiveWork;
    let totalOffDays = 0;
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
        totalOffDays++;
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

      // 3. PTO 強制休假確認 (是否有排定特休卻被排上班的情況)
      if (employee.pto.includes(dateStr) && shiftId !== 'PTO') {
        warnings.push({
          type: 'pto_conflict',
          severity: 'error',
          employeeId: employee.id,
          employeeName: employee.name,
          date: dateStr,
          message: `${employee.name} 於本日已申請特休 (PTO)，卻被指派了「${shiftMap.get(shiftId)?.name || shiftId}」，請予以排休！`
        });
      }

      prevShiftId = shiftId;
    }

    // 4. 每月固定休假天數驗證
    if (totalOffDays < state.daysOff) {
      warnings.push({
        type: 'off_days_short',
        severity: 'warning',
        employeeId: employee.id,
        employeeName: employee.name,
        message: `${employee.name} 本月排定休假共 ${totalOffDays} 天，少於設定的固定休假天數 ${state.daysOff} 天（相差 ${state.daysOff - totalOffDays} 天）。`
      });
    } else if (totalOffDays > state.daysOff) {
      warnings.push({
        type: 'off_days_excess',
        severity: 'info',
        employeeId: employee.id,
        employeeName: employee.name,
        message: `${employee.name} 本月排定休假共 ${totalOffDays} 天，多於設定的固定休假天數 ${state.daysOff} 天。`
      });
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
        empRoster[dateStr] = 'PTO';
        ptoDates.push(dateStr);
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
    // 重新完整統計所有 OFF + PTO 天數（Step 2 可能已插入額外 OFF）
    const recountOff = () => {
      let count = 0;
      for (let d = 1; d <= daysCount; d++) {
        const dateStr = formatDateISO(year, month, d);
        if (empRoster[dateStr] === 'OFF' || empRoster[dateStr] === 'PTO') {
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
      
      // 區分非預設週休與預設週休的 OFF
      const eligibleNonDefaultOffs = [];
      const eligibleDefaultOffs = [];
      
      for (let d = 1; d <= daysCount; d++) {
        const dateStr = formatDateISO(year, month, d);
        if (empRoster[dateStr] === 'OFF') {
          const dayOfWeek = getDayOfWeek(year, month, d);
          const isDefaultOff = emp.defaultOffDays && emp.defaultOffDays.includes(dayOfWeek);
          if (isDefaultOff) {
            eligibleDefaultOffs.push(dateStr);
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
    // 1. 計算該員工當前總休假天數 (OFF + PTO)
    let totalOffDays = 0;
    const offDates = []; // 儲存所有排定為 'OFF' 的日期
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
      const shiftId = newRoster[dateStr][emp.id];
      if (shiftId === 'OFF' || shiftId === 'PTO') {
        totalOffDays++;
        if (shiftId === 'OFF') {
          offDates.push({ d, dateStr });
        }
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
  shiftMap.set('LOA', { id: 'LOA', name: '留職停薪', start: '00:00', end: '00:00' });
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
    if (emp.pto.includes(dateStr) && shiftId !== 'PTO') {
      return false;
    }

    prevId = shiftId;
  }

  return true;
}

// 交換優化演算法：微調每人休假天數，使其精準等於目標固定休假天數 (e.g. 8天)
function adjustRosterForExactDaysOff(newRoster, daysCount) {
  const staffList = state.staff;
  const shiftList = state.shifts;
  
  // 重複執行數次交換以收斂結果
  for (let iteration = 0; iteration < 3; iteration++) {
    // 重新計算每個人的休假總天數
    const offCounts = {};
    staffList.forEach(emp => {
      offCounts[emp.id] = 0;
      for (let d = 1; d <= daysCount; d++) {
        const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
        const sId = newRoster[dateStr][emp.id];
        if (sId === 'OFF' || sId === 'PTO') {
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
  shiftMap.set('LOA', { id: 'LOA', name: '留職停薪', start: '00:00', end: '00:00' });
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
      if (emp.pto.includes(dateStr) && shiftId !== 'PTO') {
        warnings.push({ severity: 'error' });
      }

      prevId = shiftId;
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

  // 優先使用全域固定的排序，如果 sortedStaffIds 還未初始化或有缺失，自動重建之
  if (!state.sortedStaffIds || state.sortedStaffIds.length !== staffList.length) {
    rebuildSortedStaffIds();
  }
  
  // 根據 state.sortedStaffIds 將 staffList 對齊並渲染
  const sortedStaff = [];
  state.sortedStaffIds.forEach(id => {
    const emp = staffList.find(e => e.id === id);
    if (emp) sortedStaff.push(emp);
  });
  
  // 如果有名單中存在但不在 sortedStaffIds 中的人（例如剛新增），將其附加在尾端
  staffList.forEach(emp => {
    if (!state.sortedStaffIds.includes(emp.id)) {
      sortedStaff.push(emp);
    }
  });

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

      // 格子內部 DOM 結構：結合下拉隱形 Selector 以便滑動點擊調整班表
      const cellInner = document.createElement('div');
      cellInner.className = `roster-cell-inner ${hasConflict ? 'cell-warning-glow' : ''} ${isSupportShift ? 'cell-support-assigned' : ''}`;
      cellInner.dataset.employeeId = employee.id;
      cellInner.dataset.date = dateStr;
      
      // 建立下拉選單內容 (隱形於滑鼠懸停) - 任何人都可以直接手動調整為任何班別 (包括獨立班D)
      let selectOptions = `
        <option value="OFF" ${assignedShiftId === 'OFF' ? 'selected' : ''}>休假 (OFF)</option>
        <option value="PTO" ${assignedShiftId === 'PTO' ? 'selected' : ''}>特休 (PTO)</option>
        <option value="LOA" ${assignedShiftId === 'LOA' ? 'selected' : ''}>留職停薪 (LOA)</option>
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

    // 計算當日已排班人數 (非 OFF 且非 PTO)
    let activeWorking = 0;
    staffList.forEach(emp => {
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      if (shiftId !== 'OFF' && shiftId !== 'PTO') {
        activeWorking++;
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

      if (!state.roster[date]) {
        state.roster[date] = {};
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

// D. 渲染側邊欄客服人員名單 (Staff List Panel)
function renderStaffList() {
  const container = document.getElementById('staff-list');
  container.innerHTML = '';

  if (state.staff.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">尚無在職人員</div>`;
    return;
  }

  state.staff.forEach(emp => {
    const card = document.createElement('div');
    card.className = 'staff-card';
    card.setAttribute('draggable', 'true');
    card.dataset.id = emp.id;
    card.style.cursor = 'grab';

    // HTML5 拖曳排序事件監聽
    card.addEventListener('dragstart', function(e) {
      dragSrcEl = this;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', emp.id);
    });

    card.addEventListener('dragover', function(e) {
      e.preventDefault();
      this.classList.add('drag-over');
    });

    card.addEventListener('dragleave', function() {
      this.classList.remove('drag-over');
    });

    card.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      document.querySelectorAll('.staff-card').forEach(c => c.classList.remove('drag-over'));
    });

    card.addEventListener('drop', function(e) {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/plain');
      const targetId = this.dataset.id;
      if (draggedId !== targetId) {
        const draggedIdx = state.staff.findIndex(item => item.id === draggedId);
        const targetIdx = state.staff.findIndex(item => item.id === targetId);
        if (draggedIdx !== -1 && targetIdx !== -1) {
          const [removed] = state.staff.splice(draggedIdx, 1);
          state.staff.splice(targetIdx, 0, removed);
          
          // 更新所有人的 sortIndex 以持久化拖曳排序
          state.staff.forEach((emp, idx) => { emp.sortIndex = idx; });
          
          state.hasUnsavedChanges = true;
          updateUnsavedChangesUI();
          rebuildSortedStaffIds();
          renderAll();
        }
      }
    });

    card.innerHTML = `
      <div class="staff-card-info" style="pointer-events: none;">
        <div class="staff-avatar">${emp.name.charAt(0)}</div>
        <div class="staff-details">
          <span class="staff-name">${emp.name}</span>
          <span class="staff-desc">已排特休: ${emp.pto.length} 天</span>
        </div>
      </div>
      <div class="staff-actions" style="pointer-events: auto;">
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
      A: 0, B: 0, C: 0, OFF: 0, PTO: 0, custom: 0, totalWorkHours: 0,
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
      } else {
        // 累計各班別工時 (預設三班均為 9 小時，扣除休息時間實計 8 小時，此處簡單用 8 小時估算)
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

  // 已自動依照與客服人員名單及班表總覽相同的順序，維持畫面一致性

  // 渲染公平性進度條
  // 滿分理想工時參考：本月上班天數 * 8 小時
  const maxIdealHours = (daysCount - state.daysOff) * 8;

  stats.forEach(({ emp, counts }) => {
    const totalOff = counts.OFF + counts.PTO;
    
    // 計算比例以利在進度條畫出不同顏色區間 (早/中/晚/自訂/休)
    const totalDays = daysCount;
    const pctA = (counts.A / totalDays) * 100;
    const pctB = (counts.B / totalDays) * 100;
    const pctC = (counts.C / totalDays) * 100;
    const pctCustom = (counts.custom / totalDays) * 100;
    const pctOff = (totalOff / totalDays) * 100;

    const item = document.createElement('div');
    item.className = 'fairness-staff-item';
    item.innerHTML = `
      <div class="fairness-staff-header">
        <span class="fairness-staff-name">${emp.name}</span>
        <span class="fairness-staff-hours">實計工時: ${counts.totalWorkHours} hrs (休假 ${totalOff} 天)</span>
      </div>
      <div class="fairness-progress-bar-container" title="早班 ${counts.A}天, 中班 ${counts.B}天, 晚班 ${counts.C}天, 自訂 ${counts.custom}天, 休假/特休 ${totalOff}天" style="margin-bottom: 4px;">
        <div class="fairness-bar-segment fairness-bar-early" style="width: ${pctA}%"></div>
        <div class="fairness-bar-segment fairness-bar-middle" style="width: ${pctB}%"></div>
        <div class="fairness-bar-segment fairness-bar-late" style="width: ${pctC}%"></div>
        <div class="fairness-bar-segment fairness-bar-custom" style="width: ${pctCustom}%"></div>
        <div class="fairness-bar-segment fairness-bar-off" style="width: ${pctOff}%"></div>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 12px; padding: 0 2px; border-bottom: 1px dashed rgba(255,255,255,0.05); padding-bottom: 6px;">
        <span>🏢 信義辦公: <strong style="color: var(--accent-blue);">${counts.xinyiDays}</strong> 天</span>
        <span>🌴 平日休: <strong style="color: var(--text-primary);">${counts.weekdayOffCount}</strong> 天 / 假日休: <strong style="color: var(--text-primary);">${counts.weekendOffCount}</strong> 天</span>
      </div>
    `;
    container.appendChild(item);
  });

  // 繪製公平性圖例
  container.innerHTML += `
    <div class="fairness-breakdown-legend">
      <div class="legend-dot-item"><span class="legend-dot fairness-bar-early"></span> <span>早班</span></div>
      <div class="legend-dot-item"><span class="legend-dot fairness-bar-middle"></span> <span>中班</span></div>
      <div class="legend-dot-item"><span class="legend-dot fairness-bar-late"></span> <span>晚班</span></div>
      <div class="legend-dot-item"><span class="legend-dot fairness-bar-custom"></span> <span>自訂</span></div>
      <div class="legend-dot-item"><span class="legend-dot fairness-bar-off"></span> <span>休/特</span></div>
    </div>
  `;
}

// G. 渲染底部合規衝突警告報告 (Warnings Panel)
function renderWarningsReport() {
  const panel = document.getElementById('warnings-panel');
  const list = document.getElementById('warning-list-items');
  const countSpan = document.getElementById('warning-count');

  const currentWarnings = auditRoster(state.currentYear, state.currentMonth);
  
  if (currentWarnings.length === 0) {
    panel.classList.add('display-none');
    
    // 更新 Dashboard 上方的 Metric Card
    document.getElementById('stat-compliance').textContent = '100%';
    const complianceText = document.getElementById('stat-compliance-text');
    complianceText.textContent = '無勞基法違規項目';
    complianceText.className = 'metric-desc text-green';

    const container = document.getElementById('compliance-icon-container');
    container.className = 'metric-icon icon-green';
    return;
  }

  // 顯示衝突面板
  panel.classList.remove('display-none');
  list.innerHTML = '';
  
  // 過濾出 error (違規) 與 warning (警告) 的數量
  const errors = currentWarnings.filter(w => w.severity === 'error');
  countSpan.textContent = currentWarnings.length;

  // 更新 Dashboard 上方的 Metric Card
  const compliancePct = Math.max(0, 100 - (errors.length * 15));
  document.getElementById('stat-compliance').textContent = `${compliancePct}%`;
  
  const complianceText = document.getElementById('stat-compliance-text');
  const container = document.getElementById('compliance-icon-container');
  
  if (errors.length > 0) {
    complianceText.textContent = `偵測到 ${errors.length} 項勞基法合規錯誤！`;
    complianceText.className = 'metric-desc text-red';
    container.className = 'metric-icon icon-red animate-float-slow'; // 警告卡片震動/漂浮
  } else {
    complianceText.textContent = `勞基法合規，有 ${currentWarnings.length} 項覆蓋率警告`;
    complianceText.className = 'metric-desc text-orange';
    container.className = 'metric-icon icon-orange';
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
    document.getElementById('stat-coverage').textContent = '0%';
    document.getElementById('stat-coverage-text').textContent = '請先建立人員名單';
    document.getElementById('stat-avg-hours').textContent = '0 hrs';
    return;
  }

  // 2. 人工工時與平均工時計算
  let totalHours = 0;
  for (let d = 1; d <= daysCount; d++) {
    const dateStr = formatDateISO(state.currentYear, state.currentMonth, d);
    state.staff.forEach(emp => {
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      if (shiftId !== 'OFF' && shiftId !== 'PTO') {
        totalHours += 8; // 每班標準估計工時 8hr
      }
    });
  }

  const avgHours = totalHours / totalEmployees;
  document.getElementById('stat-avg-hours').textContent = `${avgHours.toFixed(1)} hrs`;

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
    if (shiftId !== 'OFF' && shiftId !== 'PTO') {
      scheduledToday++;
    }
  });

  const coveragePct = requiredToday > 0 ? Math.min(100, Math.round((scheduledToday / requiredToday) * 100)) : 100;
  document.getElementById('stat-coverage').textContent = `${coveragePct}%`;
  document.getElementById('stat-coverage-text').textContent = `以 ${targetDay}日為例: 需求 ${requiredToday}人, 實到 ${scheduledToday}人`;
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

  document.getElementById('modal-employee-title').textContent = `編輯 ${emp.name} 的休假預設與特休`;
  
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
    const isPto = tempPtoDays.includes(dateStr);

    const dayCell = document.createElement('div');
    dayCell.className = `modal-cal-day ${isPto ? 'pto-active' : ''}`;
    dayCell.dataset.date = dateStr;
    dayCell.innerHTML = `
      <span>${d}</span>
      <span class="modal-cal-day-name">${getDayOfWeekName(dayOfWeek)}</span>
    `;

    // 點選切換 PTO 狀態
    dayCell.addEventListener('click', function() {
      const targetDate = this.dataset.date;
      if (tempPtoDays.includes(targetDate)) {
        tempPtoDays = tempPtoDays.filter(x => x !== targetDate);
        this.classList.remove('pto-active');
      } else {
        tempPtoDays.push(targetDate);
        this.classList.add('pto-active');
      }
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

  // 套用暫存與輸入變數
  state.staff[empIndex].pto = tempPtoDays;
  state.staff[empIndex].defaultOffDays = tempDefaultOffDays;
  
  state.staff[empIndex].defaultWorkShift = document.getElementById('input-emp-default-shift').value || 'A';

  // 如果排程中有 PTO 的日子排了其他班，自動修正為休假
  tempPtoDays.forEach(dateStr => {
    if (state.roster[dateStr]) {
      state.roster[dateStr][activeConfigEmpId] = 'PTO';
    }
  });

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

    // 計算當日已排班人數 (非 OFF 且非 PTO)
    let activeWorking = 0;
    staffList.forEach(emp => {
      const shiftId = (state.roster[dateStr] && state.roster[dateStr][emp.id]) || 'OFF';
      if (shiftId !== 'OFF' && shiftId !== 'PTO') {
        activeWorking++;
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
        state.daysOff = parsed.daysOff || 8;
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
  saveToLocalStorage();
  updateUnsavedChangesUI();
  
  if (state.googleWebAppUrl) {
    syncRosterToCloud(true); // 靜默上傳
  }
  
  alert('班表已成功儲存！');
  rebuildSortedStaffIds();
}

// 取消所有變更
function cancelRosterChanges() {
  if (confirm('確定要取消所有未儲存的變更嗎？此動作將還原為上一次儲存的班表與人員設定狀態。')) {
    state.roster = JSON.parse(JSON.stringify(state.backupRoster || {}));
    state.staff = JSON.parse(JSON.stringify(state.backupStaff || []));
    state.hasUnsavedChanges = false;
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
      state.daysOff = cloudState.daysOff || 8;
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


// 11. 事件監聽與 DOM 初始化 (Event Bindings)
document.addEventListener('DOMContentLoaded', () => {
  
  // 1. 初始化資料庫與狀態
  initDatabase();
  populateYearMonthSelectors();

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
    saveToLocalStorage();
    rebuildSortedStaffIds();
    renderAll();
  });

  monthSelect.addEventListener('change', function() {
    state.currentMonth = parseInt(this.value);
    saveToLocalStorage();
    rebuildSortedStaffIds();
    renderAll();
  });

  daysOffInput.addEventListener('change', function() {
    state.daysOff = Math.max(4, Math.min(15, parseInt(this.value) || 8));
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

  // 6. 自訂班別面板操作事件
  const addShiftBtn = document.getElementById('btn-add-shift');
  const addShiftForm = document.getElementById('add-shift-form');
  const shiftCancelBtn = document.getElementById('btn-shift-cancel');
  const shiftSubmitBtn = document.getElementById('btn-shift-submit');
  const shiftNameInput = document.getElementById('input-shift-name');
  const shiftStartInput = document.getElementById('input-shift-start');
  const shiftEndInput = document.getElementById('input-shift-end');

  addShiftBtn.addEventListener('click', () => {
    addShiftForm.classList.remove('display-none');
    shiftNameInput.focus();
  });

  shiftCancelBtn.addEventListener('click', () => {
    addShiftForm.classList.add('display-none');
    shiftNameInput.value = '';
  });

  shiftSubmitBtn.addEventListener('click', () => {
    const name = shiftNameInput.value.trim();
    const start = shiftStartInput.value;
    const end = shiftEndInput.value;

    if (!name) {
      alert('請輸入班次簡稱！');
      return;
    }
    
    addShift(name, start, end);
    addShiftForm.classList.add('display-none');
    shiftNameInput.value = '';
  });

  // 7. 一鍵自動排班按鈕事件
  document.getElementById('btn-auto-schedule').addEventListener('click', function() {
    if (state.staff.length === 0) {
      alert('請先在左側新增至少一位客服人員！');
      return;
    }

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

  // 匯出選單點擊切換與外部點擊收合
  const exportBtn = document.getElementById('btn-export-menu');
  const dropdownContainer = exportBtn.closest('.dropdown');
  exportBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropdownContainer.classList.toggle('active');
  });
  document.addEventListener('click', () => {
    dropdownContainer.classList.remove('active');
  });

  // 10. 匯出選單項目事件
  document.getElementById('export-csv').addEventListener('click', (e) => {
    e.preventDefault();
    exportRosterToCSV();
  });
  document.getElementById('export-json').addEventListener('click', (e) => {
    e.preventDefault();
    exportRosterToJSON();
  });
  document.getElementById('import-json-trigger').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('import-json-file').click();
  });
  document.getElementById('import-json-file').addEventListener('change', importRosterFromJSON);

  // 一鍵列印 PDF
  document.getElementById('export-pdf').addEventListener('click', (e) => {
    e.preventDefault();
    window.print();
  });

  // 重置為預設值
  document.getElementById('reset-defaults').addEventListener('click', (e) => {
    e.preventDefault();
    if (confirm('確定要將所有排班設定、人員名單與已排班表重置為預設值嗎？此動作無法復原。')) {
      loadDefaults();
      renderAll();
      alert('已重置為預設排班設定！');
    }
  });

  // 儲存/取消按鈕
  const btnSaveRoster = document.getElementById('btn-save-roster');
  const btnCancelRoster = document.getElementById('btn-cancel-roster');
  
  if (btnSaveRoster) {
    btnSaveRoster.addEventListener('click', saveRosterChanges);
  }
  
  if (btnCancelRoster) {
    btnCancelRoster.addEventListener('click', cancelRosterChanges);
  }

  // 11. 首次繪製
  renderAll();
});
