/**
 * Smart Energy Monitor - JavaScript Controller
 * Automated Electricity Billing and Monitoring System (ESP32 Prototype)
 */

// ================= FIREBASE CONFIGURATION =================
const firebaseConfig = {
  projectId: "robust-mile-tpthm",
  appId: "1:403516623750:web:20794b71e2826f42ddfa07",
  apiKey: "AIzaSyBZkGNoke-L88Aa9VZqZqQVQ5f1pvtgxaU",
  authDomain: "robust-mile-tpthm.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-smartelectricmon-5e16e134-5238-4a5a-b723-5e13ce1276d2",
  storageBucket: "robust-mile-tpthm.firebasestorage.app",
  messagingSenderId: "403516623750",
  oAuthClientId: "403516623750-71pglkh539u9d4a4qpdisftqubbtdhsm.apps.googleusercontent.com"
};

let firebaseApp = null;
let firebaseAuth = null;
let firestoreDb = null;

try {
  if (typeof firebase !== 'undefined') {
    firebaseApp = firebase.initializeApp(firebaseConfig);
    firebaseAuth = firebase.auth();
    firestoreDb = firebase.firestore();
  }
} catch (e) {
  console.warn("Firebase Init status:", e.message);
}

// ================= AUTH & USER STATE =================
let currentUser = {
  uid: 'user_001',
  email: 'vpranav88380@gmail.com',
  displayName: 'Pranav (Authorizer)',
  role: 'authorizer' // 'customer' or 'authorizer'
};
let selectedLoginRole = 'customer';

// ================= GLOBAL STATE =================
let isDemoMode = true;
let isESP32Connected = false;
let isSerialConnected = false;
let serialPort = null;
let serialReader = null;
let pollTimer = null;
let lastServerResponseTime = Date.now();

let settings = {
  apiUrl: '/api/meter-data',
  meterId: 'TN-MTR-001',
  tariff: 8.00,
  highThreshold: 5.0,
  pollInterval: 2000
};

let meterData = {
  voltage: 5.02,
  current: 0.42,
  power: 2.11,
  energy: 0.0042,
  tamper: false,
  lastUpdated: new Date().toLocaleTimeString(),
  status: 'ONLINE'
};

let alertLogs = [
  {
    id: 'ALT-1001',
    timestamp: new Date(Date.now() - 3600000).toLocaleTimeString(),
    rawTime: Date.now() - 3600000,
    type: 'HIGH_LOAD',
    meterId: 'TN-MTR-001',
    value: '6.5 W',
    status: 'RESOLVED',
    description: 'Power load exceeded threshold limit of 5.0 W.'
  }
];

// Regional Meter Fleet Data for Electricity Board View
let ebMeters = [
  { id: 'TN-MTR-001', location: 'Household Prototype A', power: 2.11, todayKwh: 3.82, status: 'ONLINE', alert: 'Normal' },
  { id: 'TN-MTR-002', location: 'Household B (Residential)', power: 34.2, todayKwh: 4.10, status: 'ONLINE', alert: 'Normal' },
  { id: 'TN-MTR-003', location: 'Commercial Complex C', power: 185.0, todayKwh: 14.5, status: 'ONLINE', alert: 'High Load' },
  { id: 'TN-MTR-004', location: 'Apartment Block D', power: 0.0, todayKwh: 2.10, status: 'OFFLINE', alert: 'Offline' },
  { id: 'TN-MTR-005', location: 'Industrial Unit E', power: 420.0, todayKwh: 32.0, status: 'ONLINE', alert: 'Normal' }
];

// Charts references
let liveChart = null;
let dailyChart = null;
let weeklyChart = null;
let monthlyChart = null;

const liveChartMaxPoints = 15;
let liveChartLabels = [];
let liveChartData = [];

// Peak Statistics tracking
let peakLoadToday = 0.0;
let minLoadToday = 999.0;
let totalPowerSum = 0.0;
let powerReadingsCount = 0;

// ================= DOM INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  loadSavedUserSession();
  loadSettingsFromStorage();
  updateDashboard();
  calculateBill();
  calculateEstimatedBill();
  renderAlertsTable();
  renderEBMetersTable();

  // Listen to Firebase Auth state if available
  if (firebaseAuth) {
    firebaseAuth.onAuthStateChanged(user => {
      if (user) {
        currentUser.uid = user.uid;
        currentUser.email = user.email;
        currentUser.displayName = user.displayName || user.email.split('@')[0];
        // If authorizer email or previously selected role, keep role
        const savedRole = localStorage.getItem('smart_energy_role');
        if (savedRole) {
          currentUser.role = savedRole;
        } else if (user.email === 'vpranav88380@gmail.com') {
          currentUser.role = 'authorizer';
        }
        applyUserRole(currentUser);
      }
    });
  }

  // Start initial data loop
  startDataLoop();
});

// ================= AUTHENTICATION & ROLE MANAGEMENT =================
function loadSavedUserSession() {
  const saved = localStorage.getItem('smart_energy_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
    } catch (e) {
      console.warn("Could not parse saved user session");
    }
  }
  applyUserRole(currentUser);
}

function openLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.remove('hidden');
}

function closeLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.add('hidden');
}

function selectLoginRole(role) {
  selectedLoginRole = role;
  const optCustomer = document.getElementById('roleOptCustomer');
  const optAuthorizer = document.getElementById('roleOptAuthorizer');
  const googleBtnText = document.getElementById('googleBtnText');

  if (role === 'customer') {
    if (optCustomer) optCustomer.classList.add('active');
    if (optAuthorizer) optAuthorizer.classList.remove('active');
    if (googleBtnText) googleBtnText.textContent = 'Continue with Google (Consumer)';
  } else {
    if (optAuthorizer) optAuthorizer.classList.add('active');
    if (optCustomer) optCustomer.classList.remove('active');
    if (googleBtnText) googleBtnText.textContent = 'Continue with Google (Authorizer)';
  }
}

async function handleGoogleSignIn() {
  if (firebaseAuth) {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const result = await firebaseAuth.signInWithPopup(provider);
      const user = result.user;
      const role = selectedLoginRole || (user.email === 'vpranav88380@gmail.com' ? 'authorizer' : 'customer');
      
      setCurrentUserSession({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email.split('@')[0],
        role: role
      });
      closeLoginModal();
      return;
    } catch (err) {
      console.warn("Google Sign-In Popup notice:", err);
      if (err.code !== 'auth/popup-closed-by-user') {
        alertFeedback("Google Sign-In: using role access profile (" + selectedLoginRole + ")");
      }
    }
  }
  quickLoginRole(selectedLoginRole);
}

function quickLoginRole(role) {
  const isAuth = (role === 'authorizer');
  const user = {
    uid: isAuth ? 'auth_01' : 'cust_01',
    email: isAuth ? 'authorizer@tneb.gov.in' : 'consumer@household.in',
    displayName: isAuth ? 'Pranav (EB Authorizer)' : 'Household Consumer',
    role: role
  };
  setCurrentUserSession(user);
  closeLoginModal();
  alertFeedback(`Signed in as ${isAuth ? 'Electricity Board Authorizer' : 'Consumer / Household User'}`);
}

function setCurrentUserSession(user) {
  currentUser = user;
  localStorage.setItem('smart_energy_user', JSON.stringify(currentUser));
  localStorage.setItem('smart_energy_role', currentUser.role);
  applyUserRole(currentUser);
}

function applyUserRole(user) {
  const isCustomer = (user.role === 'customer');
  const roleBadge = document.getElementById('userRoleBadge');
  const roleLabel = document.getElementById('userRoleLabel');
  const roleIcon = document.getElementById('userRoleIcon');
  const nameDisplay = document.getElementById('userNameDisplay');
  const quickActions = document.getElementById('authorizerQuickActions');

  // Update header badges
  if (roleBadge) {
    roleBadge.className = isCustomer ? 'user-role-badge role-customer' : 'user-role-badge role-authorizer';
  }
  if (roleLabel) {
    roleLabel.textContent = isCustomer ? 'CONSUMER' : 'EB AUTHORIZER';
  }
  if (roleIcon) {
    roleIcon.className = isCustomer ? 'fa-solid fa-house-user' : 'fa-solid fa-user-shield';
  }
  if (nameDisplay) {
    nameDisplay.textContent = user.displayName || (isCustomer ? 'Consumer' : 'Authorizer');
  }

  // Toggle quick action simulation buttons
  if (quickActions) {
    quickActions.style.display = isCustomer ? 'none' : 'flex';
  }

  // Filter sidebar navigation items based on role
  const authorizerTabs = document.querySelectorAll('[data-role="authorizer"]');
  authorizerTabs.forEach(el => {
    if (isCustomer) {
      el.style.display = 'none';
    } else {
      el.style.display = '';
    }
  });

  // If consumer is currently on an authorizer-only tab, switch back to overview
  if (isCustomer) {
    const currentHash = window.location.hash.replace('#', '') || 'overview';
    if (['alerts', 'meter', 'eb', 'settings'].includes(currentHash)) {
      switchTab('overview');
    }
  }
}

// ================= CHART.JS INITIALIZATION =================
function initCharts() {
  const ctxLive = document.getElementById('livePowerChart')?.getContext('2d');
  const ctxDaily = document.getElementById('dailyEnergyChart')?.getContext('2d');
  const ctxWeekly = document.getElementById('weeklyUsageChart')?.getContext('2d');
  const ctxMonthly = document.getElementById('monthlyUsageChart')?.getContext('2d');

  if (!ctxLive || !ctxDaily || !ctxWeekly || !ctxMonthly) return;

  // 1. Live Power Chart (Line)
  liveChart = new Chart(ctxLive, {
    type: 'line',
    data: {
      labels: liveChartLabels,
      datasets: [{
        label: 'Power Draw (Watts)',
        data: liveChartData,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.15)',
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointBackgroundColor: '#3b82f6'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
        y: { beginAtZero: true, grid: { color: '#334155' }, ticks: { color: '#94a3b8' } }
      },
      plugins: { legend: { display: false } }
    }
  });

  // 2. Daily Energy Chart (Bar)
  dailyChart = new Chart(ctxDaily, {
    type: 'bar',
    data: {
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      datasets: [{
        label: 'Daily Consumption (kWh)',
        data: [4.2, 3.8, 4.5, 4.1, 3.9, 5.2, 4.8],
        backgroundColor: '#10b981',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
        y: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } }
      },
      plugins: { legend: { display: false } }
    }
  });

  // 3. Weekly Usage Chart (Line)
  weeklyChart = new Chart(ctxWeekly, {
    type: 'line',
    data: {
      labels: ['Wk 1', 'Wk 2', 'Wk 3', 'Wk 4'],
      datasets: [{
        label: 'Weekly Energy (kWh)',
        data: [28.5, 31.2, 29.8, 30.5],
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.2)',
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
        y: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } }
      },
      plugins: { legend: { display: false } }
    }
  });

  // 4. Monthly Usage Chart (Bar)
  monthlyChart = new Chart(ctxMonthly, {
    type: 'bar',
    data: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      datasets: [{
        label: 'Monthly Usage (kWh)',
        data: [115, 122, 130, 128, 145, 138, 140, 135, 129, 130, 125, 132],
        backgroundColor: '#a855f7',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
        y: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

// ================= DATA LOOP & POLLING =================
function startDataLoop() {
  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(() => {
    if (isDemoMode) {
      generateDemoReading();
    } else {
      fetchMeterData();
    }
  }, settings.pollInterval);
}

// ================= FETCH REAL ESP32 DATA FROM API =================
async function fetchMeterData() {
  if (isDemoMode) return;

  try {
    const response = await fetch(settings.apiUrl, { method: 'GET' });
    if (response.ok) {
      const data = await response.json();
      
      // Check if real ESP32 is actively communicating (via HTTP POST or USB serial)
      if (data.connected === true || isSerialConnected) {
        lastServerResponseTime = Date.now();
        isESP32Connected = true;
        updateMeterData(data);
        if (!meterData.tamper) {
          setConnectionStatus('ONLINE', 'ESP32 CONNECTED');
        }
      } else {
        // Backend API is reachable, but physical ESP32 has not posted within 6 seconds
        isESP32Connected = false;
        setConnectionStatus('OFFLINE', 'ESP32 DISCONNECTED');
      }
    } else {
      isESP32Connected = false;
      setConnectionStatus('OFFLINE', 'ESP32 DISCONNECTED');
    }
  } catch (error) {
    console.warn("API fetch error or ESP32 unreachable:", error.message);
    isESP32Connected = false;
    setConnectionStatus('OFFLINE', 'ESP32 DISCONNECTED');
  }
}

// ================= UPDATE METER DATA STATE =================
function updateMeterData(data) {
  if (data.voltage !== undefined) meterData.voltage = parseFloat(data.voltage);
  if (data.current !== undefined) meterData.current = parseFloat(data.current);
  if (data.power !== undefined) meterData.power = parseFloat(data.power);
  if (data.energy !== undefined) meterData.energy = parseFloat(data.energy);
  if (data.tamper !== undefined) meterData.tamper = Boolean(data.tamper);

  meterData.lastUpdated = new Date().toLocaleTimeString();

  // Track Peak / Avg / Min power statistics
  if (meterData.power > peakLoadToday) peakLoadToday = meterData.power;
  if (meterData.power < minLoadToday && meterData.power > 0) minLoadToday = meterData.power;
  totalPowerSum += meterData.power;
  powerReadingsCount++;

  // Run security checks
  checkHighConsumption();
  checkTampering();

  // Append data to live chart
  appendLiveChartData(meterData.power);

  // Update UI
  updateDashboard();
}

// ================= DEMO MODE GENERATOR =================
function generateDemoReading() {
  const baseVoltage = 5.0 + (Math.random() * 0.1 - 0.05); // ~5.0V DC
  
  let powerVal = meterData.power;
  if (powerVal > 100) {
    powerVal += (Math.random() * 4 - 2);
  } else {
    powerVal = 2.11 + (Math.random() * 1.5 - 0.75);
  }
  if (powerVal < 0) powerVal = 0.5;

  const currentVal = powerVal / baseVoltage;
  const energyVal = meterData.energy + (powerVal / 3600000);

  const simData = {
    voltage: parseFloat(baseVoltage.toFixed(2)),
    current: parseFloat(currentVal.toFixed(2)),
    power: parseFloat(powerVal.toFixed(2)),
    energy: parseFloat(energyVal.toFixed(4)),
    tamper: meterData.tamper
  };

  updateMeterData(simData);
  if (!meterData.tamper) {
    setConnectionStatus('ONLINE', 'ESP32 DEMO');
  }
}

// ================= UI UPDATE ENGINE =================
function updateDashboard() {
  // 1. Metric Cards
  const cardPower = document.getElementById('cardPower');
  const cardTodayEnergy = document.getElementById('cardTodayEnergy');
  const lastUpdated = document.getElementById('lastUpdatedTime');

  if (cardPower) cardPower.innerHTML = `${meterData.power.toFixed(1)} <span class="unit">W</span>`;
  if (cardTodayEnergy) cardTodayEnergy.innerHTML = `${(3.82 + meterData.energy).toFixed(2)} <span class="unit">kWh</span>`;
  if (lastUpdated) lastUpdated.textContent = meterData.lastUpdated;

  // 2. Live Parameters Strip
  const pVolt = document.getElementById('paramVoltage');
  const pCurr = document.getElementById('paramCurrent');
  const pUnits = document.getElementById('paramTotalUnits');
  if (pVolt) pVolt.textContent = `${meterData.voltage.toFixed(2)} V`;
  if (pCurr) pCurr.textContent = `${meterData.current.toFixed(2)} A`;
  if (pUnits) pUnits.textContent = `${(130 + meterData.energy).toFixed(4)} kWh`;

  // 3. Meter Hardware Details Tab
  const mId = document.getElementById('meterDetailId');
  const mVolt = document.getElementById('meterDetailVoltage');
  const mCurr = document.getElementById('meterDetailCurrent');
  const mPow = document.getElementById('meterDetailPower');
  const mEn = document.getElementById('meterDetailEnergy');
  const mTamper = document.getElementById('meterDetailTamper');
  const mLastTime = document.getElementById('meterDetailLastTime');

  if (mId) mId.textContent = settings.meterId;
  if (mVolt) mVolt.textContent = `${meterData.voltage.toFixed(2)} V`;
  if (mCurr) mCurr.textContent = `${meterData.current.toFixed(2)} A`;
  if (mPow) mPow.textContent = `${meterData.power.toFixed(2)} W`;
  if (mEn) mEn.textContent = `${meterData.energy.toFixed(4)} kWh`;
  if (mTamper) mTamper.textContent = meterData.tamper ? '🚨 TAMPERED (True)' : (isDemoMode ? 'SECURE (Simulation)' : (isESP32Connected ? 'SECURE (Active)' : 'DISCONNECTED'));
  if (mLastTime) mLastTime.textContent = meterData.lastUpdated;

  // 4. Energy Stats Tab
  const statPeak = document.getElementById('statPeakLoad');
  const statMin = document.getElementById('statMinPower');
  const statAvg = document.getElementById('statAvgPower');

  if (statPeak) statPeak.textContent = `${peakLoadToday.toFixed(1)} W`;
  if (statMin) statMin.textContent = `${minLoadToday === 999 ? 0 : minLoadToday.toFixed(1)} W`;
  const avg = powerReadingsCount > 0 ? (totalPowerSum / powerReadingsCount).toFixed(1) : '0.0';
  if (statAvg) statAvg.textContent = `${avg} W`;

  // 5. Update Electricity Board View
  updateEBDashboard();
}

// ================= SECURITY & THRESHOLD CHECKS =================
function checkHighConsumption() {
  const banner = document.getElementById('highPowerBanner');
  const cardPowerSub = document.getElementById('cardPowerSub');

  if (meterData.power > settings.highThreshold) {
    if (banner) {
      banner.classList.remove('hidden');
      const bPower = document.getElementById('bannerPowerVal');
      const bThresh = document.getElementById('bannerThresholdVal');
      if (bPower) bPower.textContent = `${meterData.power.toFixed(1)} W`;
      if (bThresh) bThresh.textContent = `${settings.highThreshold} W`;
    }
    if (cardPowerSub) cardPowerSub.innerHTML = `<span class="text-amber"><i class="fa-solid fa-triangle-exclamation"></i> High Load</span>`;

    logAlert('HIGH_LOAD', `${meterData.power.toFixed(1)} W`, `Current load exceeds ${settings.highThreshold} W limit.`);
  } else {
    if (banner) banner.classList.add('hidden');
    if (cardPowerSub) cardPowerSub.textContent = 'Normal load range';
  }
}

function checkTampering() {
  const banner = document.getElementById('tamperBanner');
  const cardStatus = document.getElementById('cardMeterStatus');
  const cardTamperSub = document.getElementById('cardTamperStatus');
  const securityText = document.getElementById('securityStatusText');

  if (meterData.tamper) {
    if (banner) banner.classList.remove('hidden');
    setConnectionStatus('TAMPER', 'TAMPER ALERT');

    if (cardStatus) {
      cardStatus.textContent = 'TAMPER ALERT';
      cardStatus.className = 'card-value status-text-tamper';
    }
    if (cardTamperSub) cardTamperSub.innerHTML = `<span class="text-red font-semibold">🚨 Switch Triggered!</span>`;
    
    if (securityText) {
      securityText.textContent = 'BREACH DETECTED';
      securityText.className = 'text-red font-semibold';
    }

    logAlert('METER_TAMPER', 'PHYSICAL SWITCH', 'Meter tamper button trigger activated!');
  } else {
    if (banner) banner.classList.add('hidden');
    if (meterData.status !== 'OFFLINE') {
      setConnectionStatus('ONLINE', isDemoMode ? 'ESP32 DEMO' : 'ESP32 CONNECTED');
    }
  }
}

// ================= CONNECTION STATUS CONTROLLER =================
function setConnectionStatus(type, label) {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');
  const icon = document.getElementById('statusIcon');
  const cardStatus = document.getElementById('cardMeterStatus');
  const cardTamperSub = document.getElementById('cardTamperStatus');
  const hwBadge = document.getElementById('hardwareStatusBadge');
  const hwText = document.getElementById('hardwareStatusText');

  meterData.status = type;

  if (type === 'TAMPER') {
    if (badge) badge.className = 'status-badge tamper';
    if (icon) icon.className = 'fa-solid fa-triangle-exclamation';
    if (cardStatus) {
      cardStatus.textContent = 'TAMPER ALERT';
      cardStatus.className = 'card-value status-text-tamper';
    }
  } else if (type === 'ONLINE') {
    if (badge) badge.className = 'status-badge online';
    if (icon) icon.className = 'fa-solid fa-signal';
    if (cardStatus) {
      cardStatus.textContent = isDemoMode ? 'ONLINE' : 'CONNECTED';
      cardStatus.className = 'card-value status-text-online';
    }
    if (cardTamperSub && !meterData.tamper) {
      cardTamperSub.textContent = isDemoMode ? 'Tamper: Secure' : 'Tamper: Secure (Active)';
    }
    if (hwBadge) {
      hwBadge.className = isDemoMode ? 'badge-pill pill-normal' : 'badge-pill pill-low';
      hwBadge.textContent = isDemoMode ? 'DEMO SIMULATION' : 'CONNECTED';
    }
    if (hwText) {
      hwText.textContent = isDemoMode 
        ? 'Demo Mode active. Turn off the toggle above to listen for live ESP32 telemetry from your laptop.'
        : 'ESP32 is connected to laptop and streaming telemetry.';
    }
  } else {
    // OFFLINE / DISCONNECTED
    if (badge) badge.className = 'status-badge offline';
    if (icon) icon.className = 'fa-solid fa-plug-circle-xmark';
    if (cardStatus) {
      cardStatus.textContent = 'DISCONNECTED';
      cardStatus.className = 'card-value status-text-offline';
    }
    if (cardTamperSub && !meterData.tamper) {
      cardTamperSub.textContent = 'Awaiting ESP32 connection...';
    }
    if (hwBadge) {
      hwBadge.className = 'badge-pill pill-high';
      hwBadge.textContent = 'DISCONNECTED';
    }
    if (hwText) {
      hwText.textContent = 'ESP32 is disconnected. Plug ESP32 into laptop and run sketch, or connect via USB port.';
    }
  }
  if (text) text.textContent = label;
}

// ================= LIVE CHART DATA APPEND =================
function appendLiveChartData(powerValue) {
  if (!liveChart) return;

  const timeLabel = new Date().toLocaleTimeString().split(' ')[0];
  liveChartLabels.push(timeLabel);
  liveChartData.push(powerValue);

  if (liveChartLabels.length > liveChartMaxPoints) {
    liveChartLabels.shift();
    liveChartData.shift();
  }

  liveChart.update();
}

// ================= BILLING SYSTEM CALCULATIONS =================
function calculateBill() {
  const prev = parseFloat(document.getElementById('prevReading')?.value) || 0;
  const curr = parseFloat(document.getElementById('currReading')?.value) || 0;
  const tariff = parseFloat(document.getElementById('tariffRateInput')?.value) || settings.tariff;

  let units = curr - prev;
  if (units < 0) units = 0;

  const energyCharge = units * tariff;
  const fixedCharge = 50.00;
  const tax = energyCharge * 0.05;
  const total = energyCharge + fixedCharge + tax;

  const calcUnitsEl = document.getElementById('calculatedUnits');
  const sumUnitsEl = document.getElementById('sumUnits');
  const sumRateEl = document.getElementById('sumRate');
  const sumChargeEl = document.getElementById('sumEnergyCharge');
  const sumTaxEl = document.getElementById('sumTax');
  const sumTotalEl = document.getElementById('sumTotalBill');
  const cardEstBill = document.getElementById('cardEstBill');

  if (calcUnitsEl) calcUnitsEl.value = `${units.toFixed(1)} kWh`;
  if (sumUnitsEl) sumUnitsEl.textContent = units.toFixed(1);
  if (sumRateEl) sumRateEl.textContent = tariff.toFixed(2);
  if (sumChargeEl) sumChargeEl.textContent = `₹${energyCharge.toFixed(2)}`;
  if (sumTaxEl) sumTaxEl.textContent = `₹${tax.toFixed(2)}`;
  if (sumTotalEl) sumTotalEl.textContent = `₹${total.toFixed(2)}`;
  if (cardEstBill) cardEstBill.textContent = `₹${total.toFixed(0)}`;
}

function calculateEstimatedBill() {
  const avgDailyKwh = 4.28;
  const daysInMonth = 30;
  const projectedUnits = avgDailyKwh * daysInMonth;
  const tariff = settings.tariff;
  const estBill = (projectedUnits * tariff) + 50.00;

  const projMonthly = document.getElementById('projMonthlyBill');
  const projAvg = document.getElementById('projAvgDaily');
  const projUnits = document.getElementById('projMonthlyUnits');

  if (projMonthly) projMonthly.textContent = `₹${estBill.toFixed(2)}`;
  if (projAvg) projAvg.textContent = `${avgDailyKwh.toFixed(2)} kWh/day`;
  if (projUnits) projUnits.textContent = `${projectedUnits.toFixed(1)} kWh`;

  const tierBadge = document.getElementById('tierBadge');
  const billPill = document.getElementById('billPill');

  if (projectedUnits > 200) {
    if (tierBadge) { tierBadge.textContent = 'HIGH CONSUMPTION TIER'; tierBadge.className = 'badge-pill pill-high'; }
    if (billPill) { billPill.textContent = 'High Rate'; billPill.className = 'card-sub badge-pill pill-high'; }
  } else if (projectedUnits < 80) {
    if (tierBadge) { tierBadge.textContent = 'LOW CONSUMPTION TIER'; tierBadge.className = 'badge-pill pill-low'; }
    if (billPill) { billPill.textContent = 'Economy Rate'; billPill.className = 'card-sub badge-pill pill-low'; }
  } else {
    if (tierBadge) { tierBadge.textContent = 'NORMAL CONSUMPTION TIER'; tierBadge.className = 'badge-pill pill-normal'; }
    if (billPill) { billPill.textContent = 'Normal Rate'; billPill.className = 'card-sub badge-pill pill-normal'; }
  }
}

// Generate Clean E-Bill Modal
function generateEBill() {
  calculateBill();
  const prev = document.getElementById('prevReading')?.value || '0';
  const curr = document.getElementById('currReading')?.value || '130';
  const units = document.getElementById('calculatedUnits')?.value || '130 kWh';
  const rate = document.getElementById('tariffRateInput')?.value || '8.00';
  const total = document.getElementById('sumTotalBill')?.textContent || '₹1,090.00';

  const bPrev = document.getElementById('bTablePrev');
  const bCurr = document.getElementById('bTableCurr');
  const bUnits = document.getElementById('bTableUnits');
  const bRate = document.getElementById('bTableRate');
  const bTotal = document.getElementById('bTableTotal');
  const bDate = document.getElementById('billDate');
  const bMeter = document.getElementById('billMeterId');

  if (bPrev) bPrev.textContent = `${prev} kWh`;
  if (bCurr) bCurr.textContent = `${curr} kWh`;
  if (bUnits) bUnits.textContent = units;
  if (bRate) bRate.textContent = `₹${rate} / kWh`;
  if (bTotal) bTotal.textContent = total;
  if (bDate) bDate.textContent = new Date().toLocaleDateString();
  if (bMeter) bMeter.textContent = settings.meterId;

  const modal = document.getElementById('ebillModal');
  if (modal) modal.classList.remove('hidden');
}

function closeEBillModal() {
  const modal = document.getElementById('ebillModal');
  if (modal) modal.classList.add('hidden');
}

function simulatePayment() {
  const alertBox = document.getElementById('paymentStatusAlert');
  const statusTag = document.getElementById('billStatusTag');

  if (alertBox) alertBox.classList.remove('hidden');
  if (statusTag) {
    statusTag.textContent = 'PAID';
    statusTag.className = 'bill-status-paid';
  }

  setTimeout(() => {
    if (alertBox) alertBox.classList.add('hidden');
  }, 4000);
}

// ================= ALERTS & EVENT LOGGING =================
function logAlert(type, value, description) {
  const lastAlert = alertLogs[0];
  if (lastAlert && lastAlert.type === type && (Date.now() - new Date(lastAlert.rawTime).getTime() < 10000)) {
    return;
  }

  const alertObj = {
    id: `ALT-${Math.floor(1000 + Math.random() * 9000)}`,
    timestamp: new Date().toLocaleTimeString(),
    rawTime: Date.now(),
    type: type,
    meterId: settings.meterId,
    value: value,
    status: type === 'METER_TAMPER' ? 'ACTIVE' : 'WARNING',
    description: description
  };

  alertLogs.unshift(alertObj);
  if (alertLogs.length > 50) alertLogs.pop();

  renderAlertsTable();
}

function renderAlertsTable() {
  const tbody = document.getElementById('alertsTableBody');
  const badge = document.getElementById('alertCountBadge');
  if (!tbody) return;

  tbody.innerHTML = '';
  let tamperCount = 0;
  let highLoadCount = 0;

  if (alertLogs.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td colspan="7" style="text-align: center; padding: 28px 16px; color: var(--text-muted);">
        <i class="fa-solid fa-circle-check" style="color: var(--accent-green); margin-right: 8px;"></i>
        All security alerts and incident logs have been cleared. System is secure.
      </td>
    `;
    tbody.appendChild(tr);
  } else {
    alertLogs.forEach(log => {
      if (log.type === 'METER_TAMPER') tamperCount++;
      if (log.type === 'HIGH_LOAD') highLoadCount++;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="font-semibold text-blue">${log.id}</td>
        <td>${log.timestamp}</td>
        <td>
          <span class="badge-pill ${log.type === 'METER_TAMPER' ? 'pill-high' : 'pill-normal'}">
            ${log.type === 'METER_TAMPER' ? '🚨 TAMPER DETECTED' : '⚠ HIGH CONSUMPTION'}
          </span>
        </td>
        <td><span class="meter-id-tag">${log.meterId}</span></td>
        <td>${log.value}</td>
        <td><span class="text-${log.status === 'ACTIVE' ? 'red' : 'amber'} font-semibold">${log.status}</span></td>
        <td>${log.description}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  const countTamperEl = document.getElementById('countTamperAlerts');
  const countHighEl = document.getElementById('countHighLoadAlerts');
  const secStatusEl = document.getElementById('securityStatusText');

  if (countTamperEl) countTamperEl.textContent = tamperCount;
  if (countHighEl) countHighEl.textContent = highLoadCount;
  if (secStatusEl) {
    if (tamperCount > 0) {
      secStatusEl.textContent = 'BREACH DETECTED';
      secStatusEl.className = 'text-red font-semibold';
    } else {
      secStatusEl.textContent = 'SECURE';
      secStatusEl.className = 'text-green font-semibold';
    }
  }

  // CRITICAL FIX: Explicitly toggle badge visibility and counter
  if (badge) {
    if (alertLogs.length > 0) {
      badge.textContent = alertLogs.length;
      badge.classList.remove('hidden');
    } else {
      badge.textContent = '0';
      badge.classList.add('hidden');
    }
  }
}

// CRITICAL FIX FOR NOTIFICATION BUG: Clear logs and reset badges
function clearAlertLogs() {
  alertLogs = [];

  // Hide top banners immediately
  const tamperBanner = document.getElementById('tamperBanner');
  const highPowerBanner = document.getElementById('highPowerBanner');
  if (tamperBanner) tamperBanner.classList.add('hidden');
  if (highPowerBanner) highPowerBanner.classList.add('hidden');

  // Immediately hide notification badge in sidebar
  const badge = document.getElementById('alertCountBadge');
  if (badge) {
    badge.textContent = '0';
    badge.classList.add('hidden');
  }

  // If in demo mode, reset tamper and high power triggers
  if (isDemoMode) {
    meterData.tamper = false;
    if (meterData.power > settings.highThreshold) {
      meterData.power = 2.11;
    }
    const cardTamperSub = document.getElementById('cardTamperStatus');
    if (cardTamperSub) cardTamperSub.textContent = 'Tamper: Secure';
  }

  // Clear server alerts
  fetch('/api/alerts', { method: 'DELETE' }).catch(() => {});

  renderAlertsTable();
  updateDashboard();
  alertFeedback("Alert logs cleared successfully.");
}

// ================= ELECTRICITY BOARD (EB) DASHBOARD =================
function updateEBDashboard() {
  ebMeters[0].power = meterData.power;
  ebMeters[0].todayKwh = 3.82 + meterData.energy;
  ebMeters[0].status = meterData.status === 'TAMPER' ? 'TAMPER ALERT' : (isDemoMode ? 'ONLINE' : (isESP32Connected ? 'ONLINE' : 'OFFLINE'));
  ebMeters[0].alert = meterData.tamper ? '🚨 TAMPER ALERT' : (meterData.power > settings.highThreshold ? '⚠ High Load' : 'Normal');

  renderEBMetersTable();
}

function renderEBMetersTable() {
  const tbody = document.getElementById('ebMetersTableBody');
  if (!tbody) return;

  tbody.innerHTML = '';
  let onlineCount = 0;
  let loadAlertsCount = 0;
  let tamperAlertsCount = 0;

  ebMeters.forEach(m => {
    if (m.status === 'ONLINE' || m.status === 'TAMPER ALERT') onlineCount++;
    if (m.alert.includes('High Load')) loadAlertsCount++;
    if (m.alert.includes('TAMPER')) tamperAlertsCount++;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="meter-id-tag">${m.id}</span></td>
      <td>${m.location}</td>
      <td class="font-semibold">${m.power.toFixed(1)} W</td>
      <td>${m.todayKwh.toFixed(2)} kWh</td>
      <td>
        <span class="badge-pill ${m.status === 'ONLINE' ? 'pill-low' : (m.status === 'TAMPER ALERT' ? 'pill-high' : 'pill-normal')}">
          ${m.status}
        </span>
      </td>
      <td>
        <span class="text-${m.alert.includes('TAMPER') ? 'red' : (m.alert.includes('High') ? 'amber' : 'green')} font-semibold">
          ${m.alert}
        </span>
      </td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="inspectMeter('${m.id}')">Inspect</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  const onlineEl = document.getElementById('ebOnlineCount');
  const loadEl = document.getElementById('ebLoadAlerts');
  const tamperEl = document.getElementById('ebTamperAlerts');

  if (onlineEl) onlineEl.textContent = `${onlineCount} / ${ebMeters.length}`;
  if (loadEl) loadEl.textContent = loadAlertsCount;
  if (tamperEl) tamperEl.textContent = tamperAlertsCount;
}

function inspectMeter(meterId) {
  switchTab('meter');
}

// ================= HACKATHON DEMO SIMULATION CONTROLS =================
function triggerHighConsumptionDemo() {
  enableDemoMode(true);
  meterData.power = 145.8;
  updateMeterData({ power: 145.8 });
  switchTab('overview');
}

function triggerTamperDemo() {
  enableDemoMode(true);
  meterData.tamper = true;
  updateMeterData({ tamper: true });
  switchTab('overview');
}

function resetDemoAlerts() {
  meterData.tamper = false;
  meterData.power = 2.11;
  updateMeterData({ power: 2.11, tamper: false });
  const hBanner = document.getElementById('highPowerBanner');
  const tBanner = document.getElementById('tamperBanner');
  if (hBanner) hBanner.classList.add('hidden');
  if (tBanner) tBanner.classList.add('hidden');
  alertFeedback("Alerts reset to normal.");
}

function enableDemoMode(enabled) {
  toggleDemoMode(enabled);
}

// CRITICAL FIX: Settings Toggle Mode Behavior
function toggleDemoMode(enabled) {
  isDemoMode = enabled;
  const badge = document.getElementById('modeBadge');
  const text = document.getElementById('modeText');
  const checkbox = document.getElementById('demoToggleCheckbox');

  if (checkbox && checkbox.checked !== enabled) {
    checkbox.checked = enabled;
  }

  if (enabled) {
    if (badge) badge.className = 'mode-badge demo-active';
    if (text) text.textContent = 'DEMO MODE ACTIVE';
    setConnectionStatus('ONLINE', 'ESP32 DEMO');
  } else {
    if (badge) badge.className = 'mode-badge live-active';
    if (text) text.textContent = 'LIVE HARDWARE MODE';

    // If Demo Mode is turned off and real ESP32 is not yet connected:
    // IMMEDIATELY show ESP32 DISCONNECTED!
    if (!isESP32Connected) {
      setConnectionStatus('OFFLINE', 'ESP32 DISCONNECTED');
    } else {
      setConnectionStatus('ONLINE', 'ESP32 CONNECTED');
    }
  }

  startDataLoop();
  if (!enabled) {
    fetchMeterData();
  }
}

// Web Serial Connect Handler (USB cable connection to laptop)
async function connectUsbSerial() {
  if (!('serial' in navigator)) {
    alertFeedback("Web Serial API not available in this browser window. Connect ESP32 via Wi-Fi HTTP POST to laptop (port 3000).");
    return;
  }

  const btn = document.getElementById('btnUsbConnect');

  if (isSerialConnected && serialPort) {
    try {
      if (serialReader) await serialReader.cancel();
      await serialPort.close();
    } catch (e) {
      console.warn("Serial close:", e);
    }
    isSerialConnected = false;
    isESP32Connected = false;
    if (btn) btn.innerHTML = '<i class="fa-brands fa-usb"></i> Connect USB Port';
    if (!isDemoMode) setConnectionStatus('OFFLINE', 'ESP32 DISCONNECTED');
    alertFeedback("ESP32 USB disconnected.");
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });
    isSerialConnected = true;
    isESP32Connected = true;

    if (btn) btn.innerHTML = '<i class="fa-solid fa-circle-stop"></i> Disconnect USB';
    if (isDemoMode) toggleDemoMode(false);
    setConnectionStatus('ONLINE', 'ESP32 CONNECTED');
    alertFeedback("ESP32 USB Connected successfully!");

    readSerialLoop();
  } catch (err) {
    console.warn("Serial connection canceled or failed:", err);
    if (err.name !== 'NotFoundError') {
      alertFeedback("USB Serial: " + err.message);
    }
  }
}

async function readSerialLoop() {
  while (serialPort && serialPort.readable && isSerialConnected) {
    const textDecoder = new TextDecoderStream();
    serialPort.readable.pipeTo(textDecoder.writable).catch(() => {});
    const reader = textDecoder.readable.getReader();
    serialReader = reader;

    let lineBuffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        lineBuffer += value;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const line of lines) {
          parseSerialLine(line.trim());
        }
      }
    } catch (e) {
      console.warn("Serial stream closed:", e);
    } finally {
      reader.releaseLock();
    }
  }
  isSerialConnected = false;
  isESP32Connected = false;
  if (!isDemoMode) setConnectionStatus('OFFLINE', 'ESP32 DISCONNECTED');
}

function parseSerialLine(line) {
  if (!line) return;
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const data = JSON.parse(line);
      data.connected = true;
      updateMeterData(data);
      if (!meterData.tamper) setConnectionStatus('ONLINE', 'ESP32 CONNECTED');
      return;
    } catch (e) {}
  }
  const vMatch = line.match(/V:\s*([\d.]+)/i);
  const iMatch = line.match(/I:\s*([\d.]+)/i);
  const pMatch = line.match(/P:\s*([\d.]+)/i);
  if (vMatch || iMatch || pMatch) {
    const patch = {};
    if (vMatch) patch.voltage = parseFloat(vMatch[1]);
    if (iMatch) patch.current = parseFloat(iMatch[1]);
    if (pMatch) patch.power = parseFloat(pMatch[1]);
    if (line.includes('TAMPER')) patch.tamper = true;
    updateMeterData(patch);
    if (!meterData.tamper) setConnectionStatus('ONLINE', 'ESP32 CONNECTED');
  }
}

// Toggle Simulated Hardware Connection (for testing)
async function toggleSimulatedHardwareConnection() {
  const target = !isESP32Connected;
  try {
    const res = await fetch('/api/simulate-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected: target })
    });
    const d = await res.json();
    isESP32Connected = d.connected;

    if (isDemoMode) {
      toggleDemoMode(false);
    } else {
      if (isESP32Connected) {
        setConnectionStatus('ONLINE', 'ESP32 CONNECTED');
        await fetchMeterData();
      } else {
        setConnectionStatus('OFFLINE', 'ESP32 DISCONNECTED');
      }
    }
    alertFeedback(isESP32Connected ? "ESP32 hardware detected and connected!" : "ESP32 disconnected.");
  } catch (e) {
    isESP32Connected = target;
    if (!isDemoMode) {
      setConnectionStatus(isESP32Connected ? 'ONLINE' : 'OFFLINE', isESP32Connected ? 'ESP32 CONNECTED' : 'ESP32 DISCONNECTED');
    }
  }
}

// ================= NAVIGATION & TAB SWITCHING =================
function switchTab(tabId) {
  // Guard customer from authorizer tabs
  if (currentUser.role === 'customer' && ['alerts', 'meter', 'eb', 'settings'].includes(tabId)) {
    tabId = 'overview';
  }

  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active'));

  const activeNav = document.querySelector(`.nav-item[href="#${tabId}"]`);
  const activeSec = document.getElementById(`section-${tabId}`);

  if (activeNav) activeNav.classList.add('active');
  if (activeSec) activeSec.classList.add('active');

  setTimeout(() => {
    if (liveChart) liveChart.resize();
    if (dailyChart) dailyChart.resize();
    if (weeklyChart) weeklyChart.resize();
    if (monthlyChart) monthlyChart.resize();
  }, 100);
}

function dismissBanner(bannerId) {
  const el = document.getElementById(bannerId);
  if (el) el.classList.add('hidden');
}

// ================= SETTINGS FORM =================
function saveSettings() {
  settings.apiUrl = document.getElementById('apiUrlInput')?.value || '/api/meter-data';
  settings.meterId = document.getElementById('meterIdInput')?.value || 'TN-MTR-001';
  settings.tariff = parseFloat(document.getElementById('tariffConfigInput')?.value) || 8.00;
  settings.highThreshold = parseFloat(document.getElementById('thresholdInput')?.value) || 100.0;
  settings.pollInterval = parseInt(document.getElementById('pollIntervalInput')?.value) || 2000;

  localStorage.setItem('smart_energy_settings', JSON.stringify(settings));

  const saveBtn = document.querySelector('#settingsForm button[type="submit"]');
  if (saveBtn) {
    const origHtml = saveBtn.innerHTML;
    saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Settings Saved!';
    setTimeout(() => {
      saveBtn.innerHTML = origHtml;
    }, 2000);
  }
  
  calculateBill();
  calculateEstimatedBill();
  startDataLoop();
  alertFeedback("Settings saved successfully.");
}

function loadSettingsFromStorage() {
  const saved = localStorage.getItem('smart_energy_settings');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.apiUrl && parsed.apiUrl.includes('localhost:5000')) {
        parsed.apiUrl = '/api/meter-data';
      }
      settings = { ...settings, ...parsed };
      if (document.getElementById('apiUrlInput')) document.getElementById('apiUrlInput').value = settings.apiUrl;
      if (document.getElementById('meterIdInput')) document.getElementById('meterIdInput').value = settings.meterId;
      if (document.getElementById('tariffConfigInput')) document.getElementById('tariffConfigInput').value = settings.tariff;
      if (document.getElementById('thresholdInput')) document.getElementById('thresholdInput').value = settings.highThreshold;
      if (document.getElementById('pollIntervalInput')) document.getElementById('pollIntervalInput').value = settings.pollInterval;
    } catch (e) {
      console.warn("Could not parse saved settings");
    }
  } else {
    if (document.getElementById('apiUrlInput')) document.getElementById('apiUrlInput').value = settings.apiUrl;
  }
}

// Non-blocking toast notification helper (replaces window.alert)
function alertFeedback(message) {
  let toast = document.getElementById('appNotificationToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appNotificationToast';
    toast.style.cssText = 'position: fixed; bottom: 24px; right: 24px; background: #1e293b; color: #f8fafc; border: 1px solid #475569; border-radius: 8px; padding: 12px 20px; font-size: 0.85rem; font-weight: 600; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); z-index: 10001; display: flex; align-items: center; gap: 10px; transition: opacity 0.3s;';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<i class="fa-solid fa-circle-info" style="color: #38bdf8;"></i> ${message}`;
  toast.style.opacity = '1';
  toast.style.display = 'flex';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 3000);
}
