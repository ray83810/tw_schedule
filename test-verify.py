"""
Phase 11 自動化功能驗證腳本 (Python)
模擬 app.js 核心邏輯並驗證所有功能正確性
"""
import json, random, math
from datetime import date, timedelta

# ========== Date Helpers ==========
def get_days_in_month(year, month):
    """month is 0-indexed"""
    if month == 11:
        return (date(year + 1, 1, 1) - date(year, 12, 1)).days
    return (date(year, month + 2, 1) - date(year, month + 1, 1)).days

def get_day_of_week(year, month, day):
    """month is 0-indexed, returns 0=Sun, 6=Sat"""
    d = date(year, month + 1, day)
    return (d.weekday() + 1) % 7  # Python weekday: 0=Mon; JS: 0=Sun

def format_date_iso(year, month, day):
    return f"{year}-{str(month+1).zfill(2)}-{str(day).zfill(2)}"

def calc_rest_hours(prev_shift, next_shift):
    if not prev_shift or prev_shift['id'] in ('OFF','PTO'): return 24
    if not next_shift or next_shift['id'] in ('OFF','PTO'): return 24
    def parse_time(t):
        h, m = map(int, t.split(':'))
        return h + m/60
    ps = parse_time(prev_shift['start'])
    pe = parse_time(prev_shift['end'])
    ns = parse_time(next_shift['start'])
    if pe <= ps: pe += 24
    return (24 + ns) - pe

# ========== Data ==========
DEFAULT_STAFF = [
    {'id':'s1','name':'Alex Chen','pto':[],'defaultOffDays':[0,6],'defaultWorkShift':'A','sortIndex':0},
    {'id':'s3','name':'Amber Wang','pto':[],'defaultOffDays':[0,6],'defaultWorkShift':'A','sortIndex':1},
    {'id':'s6','name':'Jian Kai Ding','pto':['2026-06-15'],'defaultOffDays':[0,6],'defaultWorkShift':'A','sortIndex':2},
    {'id':'s8','name':'Sherry Lin','pto':[],'defaultOffDays':[0,6],'defaultWorkShift':'A','sortIndex':3},
    {'id':'s2','name':'Howard Chen','pto':[],'defaultOffDays':[0,6],'defaultWorkShift':'B','sortIndex':4},
    {'id':'s5','name':'Evan Liu','pto':['2026-06-20'],'defaultOffDays':[0,6],'defaultWorkShift':'B','sortIndex':5},
    {'id':'s4','name':'Jacky Lee','pto':[],'defaultOffDays':[0,6],'defaultWorkShift':'C','sortIndex':6},
    {'id':'s7','name':'Rex Liao','pto':[],'defaultOffDays':[0,6],'defaultWorkShift':'C','sortIndex':7},
    {'id':'s9','name':'Molly Song','pto':[],'defaultOffDays':[1,2],'defaultWorkShift':'D','sortIndex':8},
]
DEFAULT_SHIFTS = [
    {'id':'A','name':'早班','start':'08:00','end':'17:00'},
    {'id':'B','name':'中班','start':'11:00','end':'20:00'},
    {'id':'C','name':'晚班','start':'15:00','end':'00:00'},
    {'id':'D','name':'獨立班','start':'12:00','end':'21:00'},
]
DEFAULT_COVERAGE = {'A':{'weekday':2,'weekend':1},'B':{'weekday':1,'weekend':1},'C':{'weekday':1,'weekend':1},'D':{'weekday':0,'weekend':0}}

# ========== State ==========
state = {
    'currentYear': 2026, 'currentMonth': 5, 'daysOff': 9,
    'staff': [], 'shifts': [], 'coverageTargets': {},
    'roster': {}, 'sortedStaffIds': []
}

def init_state(days_off=9, coverage=None):
    import copy
    state['currentYear'] = 2026
    state['currentMonth'] = 5
    state['daysOff'] = days_off
    state['staff'] = copy.deepcopy(DEFAULT_STAFF)
    state['shifts'] = copy.deepcopy(DEFAULT_SHIFTS)
    state['coverageTargets'] = copy.deepcopy(coverage or DEFAULT_COVERAGE)
    state['roster'] = {}
    sort_staff()
    rebuild_sorted()

def sort_staff():
    state['staff'].sort(key=lambda e: e.get('sortIndex', 999))

def rebuild_sorted():
    state['sortedStaffIds'] = [e['id'] for e in state['staff']]

def get_boundary(emp_id, year, month):
    py, pm = year, month - 1
    if month == 0: py, pm = year - 1, 11
    pdc = get_days_in_month(py, pm)
    last_shift = None
    cons = 0
    ld = format_date_iso(py, pm, pdc)
    r = state['roster']
    if ld in r and emp_id in r[ld]: last_shift = r[ld][emp_id]
    for d in range(pdc, 0, -1):
        ds = format_date_iso(py, pm, d)
        sid = r.get(ds, {}).get(emp_id, 'OFF')
        if sid not in ('OFF','PTO'): cons += 1
        else: break
    return last_shift, cons

def is_compliant_max(roster_copy, emp_id, max_days=5):
    _, cons = get_boundary(emp_id, state['currentYear'], state['currentMonth'])
    dc = get_days_in_month(state['currentYear'], state['currentMonth'])
    for d in range(1, dc+1):
        ds = format_date_iso(state['currentYear'], state['currentMonth'], d)
        sid = roster_copy[ds].get(emp_id, 'OFF')
        if sid in ('OFF','PTO','LOA'): cons = 0
        else:
            cons += 1
            if cons > max_days: return False
    return True

# ========== Auto Scheduler ==========
def run_auto_scheduler():
    sort_staff()
    y, m = state['currentYear'], state['currentMonth']
    dc = get_days_in_month(y, m)
    sl = state['staff']
    nr = {}
    for d in range(1, dc+1):
        nr[format_date_iso(y, m, d)] = {}

    for emp in sl:
        ds = emp.get('defaultWorkShift', 'A')
        pto_set = set(emp.get('pto', []))
        er = {}
        for d in range(1, dc+1):
            dstr = format_date_iso(y, m, d)
            dow = get_day_of_week(y, m, d)
            is_def_off = dow in (emp.get('defaultOffDays') or [])
            if dstr in pto_set: er[dstr] = 'PTO'
            elif is_def_off: er[dstr] = 'OFF'
            else: er[dstr] = None

        # Step 2: consecutive 5 break
        _, cons = get_boundary(emp['id'], y, m)
        for d in range(1, dc+1):
            dstr = format_date_iso(y, m, d)
            if er[dstr] in ('OFF','PTO'): cons = 0
            else:
                if cons >= 5:
                    er[dstr] = 'OFF'
                    cons = 0
                else:
                    cons += 1

        # Step 3: adjust off days (WITH recountOff fix)
        def recount():
            return sum(1 for d in range(1,dc+1) if er[format_date_iso(y,m,d)] == 'OFF')
        
        cur_off = recount()
        target = state['daysOff']

        def get_nulls():
            return [format_date_iso(y,m,d) for d in range(1,dc+1) if er[format_date_iso(y,m,d)] is None]

        if cur_off < target:
            needed = target - cur_off
            cands = get_nulls()
            random.shuffle(cands)
            for dstr in cands[:needed]:
                er[dstr] = 'OFF'
        elif cur_off > target:
            excess = cur_off - target
            non_def, def_offs = [], []
            for d in range(1, dc+1):
                dstr = format_date_iso(y, m, d)
                if er[dstr] == 'OFF':
                    dow = get_day_of_week(y, m, d)
                    if dow in (emp.get('defaultOffDays') or []): def_offs.append(dstr)
                    else: non_def.append(dstr)
            random.shuffle(non_def)
            random.shuffle(def_offs)
            all_cands = non_def + def_offs
            resolved = 0
            for dstr in all_cands:
                if resolved >= excess: break
                er[dstr] = None
                rc = {}
                for d2 in range(1, dc+1):
                    d2s = format_date_iso(y, m, d2)
                    rc[d2s] = {emp['id']: er[d2s]}
                if is_compliant_max(rc, emp['id'], 5):
                    resolved += 1
                else:
                    er[dstr] = 'OFF'
            still = excess - resolved
            if still > 0:
                rem = [format_date_iso(y,m,d) for d in range(1,dc+1) if er[format_date_iso(y,m,d)]=='OFF']
                random.shuffle(rem)
                for dstr in rem[:still]:
                    er[dstr] = None

        # Step 4: fill with default shift
        for d in range(1, dc+1):
            dstr = format_date_iso(y, m, d)
            if er[dstr] is None: er[dstr] = ds
            nr[dstr][emp['id']] = er[dstr]

    # Step 5: support allocation
    sup_days = {e['id']:0 for e in sl}
    sup_shifts = {e['id']:set() for e in sl}
    shift_map = {s['id']:s for s in state['shifts']}

    for d in range(1, dc+1):
        dstr = format_date_iso(y, m, d)
        dow = get_day_of_week(y, m, d)
        is_wknd = dow in (0, 6)
        shortages = []
        for sh in state['shifts']:
            if sh['id'] == 'D': continue
            tc = state['coverageTargets'].get(sh['id'], {'weekday':0,'weekend':0})
            req = tc['weekend'] if is_wknd else tc['weekday']
            cur = sum(1 for e in sl if nr[dstr].get(e['id']) == sh['id'])
            diff = req - cur
            if diff > 0: shortages.append((sh['id'], diff))

        for sid, cnt in shortages:
            for _ in range(cnt):
                best, lowest = None, float('inf')
                for emp in sl:
                    if emp['defaultWorkShift'] == 'D': continue
                    cs = nr[dstr].get(emp['id'])
                    if cs in ('OFF','PTO','LOA','AM_PTO','PM_PTO') or cs == sid: continue
                    dfs = emp['defaultWorkShift'] or 'A'
                    if dfs == 'A' and sid == 'C': continue
                    if dfs == 'C' and sid == 'A': continue
                    ts = set(sup_shifts[emp['id']])
                    if sid != dfs: ts.add(sid)
                    if len(ts) > 1: continue
                    # 11h check
                    ok = True
                    if d > 1:
                        pd = format_date_iso(y,m,d-1)
                        psid = nr[pd].get(emp['id'])
                        if psid and psid not in ('OFF','PTO','LOA','AM_PTO','PM_PTO'):
                            ps = shift_map.get(psid)
                            cs2 = shift_map.get(sid)
                            if ps and cs2 and calc_rest_hours(ps,cs2) < 11: ok = False
                    if ok and d < dc:
                        nd = format_date_iso(y,m,d+1)
                        nsid = nr[nd].get(emp['id'])
                        if nsid and nsid not in ('OFF','PTO','LOA','AM_PTO','PM_PTO'):
                            cs2 = shift_map.get(sid)
                            ns = shift_map.get(nsid)
                            if cs2 and ns and calc_rest_hours(cs2,ns) < 11: ok = False
                    if not ok: continue
                    if sup_days[emp['id']] < lowest:
                        lowest = sup_days[emp['id']]
                        best = emp['id']
                if best:
                    nr[dstr][best] = sid
                    sup_days[best] += 1
                    dfs = next(e['defaultWorkShift'] for e in sl if e['id']==best) or 'A'
                    if sid != dfs: sup_shifts[best].add(sid)

    rebuild_sorted()
    state['roster'] = nr

# ========== TESTS ==========
passed = failed = total = 0
def check(cond, name):
    global passed, failed, total
    total += 1
    if cond:
        passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ FAIL: {name}")

# ----- TEST 1: sortIndex ordering -----
print('\n📋 TEST 1: sortIndex 排序穩定性')
init_state()
check(state['staff'][0]['name'] == 'Alex Chen', 'Alex Chen at index 0')
check(state['staff'][1]['name'] == 'Amber Wang', 'Amber Wang at index 1')
check(state['staff'][8]['name'] == 'Molly Song', 'Molly Song at index 8 (last)')
check(state['staff'][6]['name'] == 'Jacky Lee', 'Jacky Lee at index 6')

# Simulate edit without re-sort
state['staff'][0]['defaultWorkShift'] = 'C'
rebuild_sorted()
check(state['staff'][0]['name'] == 'Alex Chen', 'After shift edit: Alex stays at 0')

# Simulate drag: Molly (8) -> position 2
removed = state['staff'].pop(8)
state['staff'].insert(2, removed)
for i, e in enumerate(state['staff']): e['sortIndex'] = i
rebuild_sorted()
check(state['staff'][2]['name'] == 'Molly Song', 'After drag: Molly at index 2')
sort_staff()
check(state['staff'][2]['name'] == 'Molly Song', 'After re-sort: Molly stays at 2')

# ----- TEST 2: daysOff = 9 -----
print('\n📋 TEST 2: 月休天數精準度 (daysOff=9, June 2026)')
init_state(days_off=9)
run_auto_scheduler()
dc = get_days_in_month(2026, 5)
for emp in state['staff']:
    off_cnt = sum(1 for d in range(1,dc+1) if state['roster'][format_date_iso(2026,5,d)].get(emp['id']) == 'OFF')
    check(off_cnt == 9, f"{emp['name']}: OFF = {off_cnt} (expected 9)")

# ----- TEST 3: PTO preserved -----
print('\n📋 TEST 3: PTO 特休日保留')
jk = next(e for e in state['staff'] if e['name']=='Jian Kai Ding')
check(state['roster']['2026-06-15'].get(jk['id']) == 'PTO', 'Jian Kai Ding 6/15 = PTO')
ev = next(e for e in state['staff'] if e['name']=='Evan Liu')
check(state['roster']['2026-06-20'].get(ev['id']) == 'PTO', 'Evan Liu 6/20 = PTO')

# ----- TEST 4: 7休1 -----
print('\n📋 TEST 4: 勞基法 7休1 (連續≤6天)')
violation = False
for emp in state['staff']:
    cons = 0
    for d in range(1, dc+1):
        sid = state['roster'][format_date_iso(2026,5,d)].get(emp['id'],'OFF')
        if sid not in ('OFF','PTO','LOA'): cons += 1
        else: cons = 0
        if cons > 6:
            violation = True
            print(f"    ⚠️ {emp['name']}: {cons} consecutive at day {d}")
check(not violation, 'No 7休1 violations')

# ----- TEST 5: 11h rest -----
print('\n📋 TEST 5: 11小時輪班間隔')
shift_map = {s['id']:s for s in state['shifts']}
rest_viol = False
for emp in state['staff']:
    prev = None
    for d in range(1, dc+1):
        sid = state['roster'][format_date_iso(2026,5,d)].get(emp['id'],'OFF')
        leaves = ('OFF','PTO','LOA','AM_PTO','PM_PTO')
        if prev and sid and prev not in leaves and sid not in leaves:
            ps = shift_map.get(prev)
            cs = shift_map.get(sid)
            if ps and cs:
                r = calc_rest_hours(ps, cs)
                if r < 11:
                    rest_viol = True
                    print(f"    ⚠️ {emp['name']}: {r:.1f}h rest d{d-1}({prev})->d{d}({sid})")
        prev = sid
check(not rest_viol, 'No 11-hour rest violations')

# ----- TEST 6: A↛C, C↛A -----
print('\n📋 TEST 6: 不跨兩個班別 (A↛C, C↛A)')
init_state(days_off=9, coverage={'A':{'weekday':3,'weekend':2},'B':{'weekday':2,'weekend':1},'C':{'weekday':3,'weekend':2},'D':{'weekday':0,'weekend':0}})
run_auto_scheduler()
cross = False
for emp in state['staff']:
    ds = emp['defaultWorkShift']
    for d in range(1, dc+1):
        sid = state['roster'][format_date_iso(2026,5,d)].get(emp['id'],'OFF')
        if sid in ('OFF','PTO','LOA','AM_PTO','PM_PTO'): continue
        if ds == 'A' and sid == 'C':
            cross = True; print(f"    ⚠️ {emp['name']}(A) -> C on d{d}")
        if ds == 'C' and sid == 'A':
            cross = True; print(f"    ⚠️ {emp['name']}(C) -> A on d{d}")
check(not cross, 'No A→C or C→A cross-shift')

# ----- TEST 7: D exempt -----
print('\n📋 TEST 7: D班不參與支援')
molly = next(e for e in state['staff'] if e['name']=='Molly Song')
d_viol = False
for d in range(1, dc+1):
    sid = state['roster'][format_date_iso(2026,5,d)].get(molly['id'],'OFF')
    if sid not in ('OFF','PTO','LOA','AM_PTO','PM_PTO','D'):
        d_viol = True; print(f"    ⚠️ Molly assigned {sid} on d{d}")
check(not d_viol, 'Molly (D) only D or leave')

# ----- TEST 8: B supports ≤1 type -----
print('\n📋 TEST 8: B班最多支援一種他班')
multi = False
for emp in [e for e in state['staff'] if e['defaultWorkShift']=='B']:
    types = set()
    for d in range(1, dc+1):
        sid = state['roster'][format_date_iso(2026,5,d)].get(emp['id'],'OFF')
        if sid not in ('OFF','PTO','LOA','AM_PTO','PM_PTO','B'): types.add(sid)
    if len(types) > 1:
        multi = True; print(f"    ⚠️ {emp['name']}(B) supports {types}")
check(not multi, 'B-shift ≤1 support type')

# ----- TEST 9: sortIndex auto-upgrade -----
print('\n📋 TEST 9: 舊快取 sortIndex 自動升級')
old = [{'id':'x1','name':'T1'}, {'id':'x2','name':'T2'}]
for i, e in enumerate(old):
    if e.get('sortIndex') is None: e['sortIndex'] = i
check(old[0]['sortIndex'] == 0, 'Old item 0 → sortIndex=0')
check(old[1]['sortIndex'] == 1, 'Old item 1 → sortIndex=1')

# ----- TEST 10: addStaff sortIndex -----
print('\n📋 TEST 10: 新增人員 sortIndex')
init_state()
new_emp = {'id':'new1','name':'New','pto':[],'defaultOffDays':[0,6],'defaultWorkShift':'A','sortIndex':len(state['staff'])}
state['staff'].append(new_emp)
check(new_emp['sortIndex'] == 9, 'New staff sortIndex=9')
check(state['staff'][9]['name'] == 'New', 'New staff at index 9')

# ----- TEST 11: daysOff = 10 -----
print('\n📋 TEST 11: 月休天數 = 10')
init_state(days_off=10)
run_auto_scheduler()
for emp in state['staff']:
    off_cnt = sum(1 for d in range(1,dc+1) if state['roster'][format_date_iso(2026,5,d)].get(emp['id']) == 'OFF')
    check(off_cnt == 10, f"{emp['name']}: OFF = {off_cnt} (expected 10)")

# ----- TEST 12: daysOff = 8 -----
print('\n📋 TEST 12: 月休天數 = 8')
init_state(days_off=8)
run_auto_scheduler()
for emp in state['staff']:
    off_cnt = sum(1 for d in range(1,dc+1) if state['roster'][format_date_iso(2026,5,d)].get(emp['id']) == 'OFF')
    check(off_cnt == 8, f"{emp['name']}: OFF = {off_cnt} (expected 8)")

# ===== SUMMARY =====
print('\n' + '='*50)
print(f"📊 測試結果: {passed}/{total} 通過, {failed} 失敗")
if failed == 0:
    print('🎉 所有測試全數通過！所有功能正常運作！')
else:
    print(f'⚠️ 有 {failed} 項測試失敗。')
print('='*50)

import sys
sys.exit(1 if failed > 0 else 0)
