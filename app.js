const menu = document.querySelector('.window-menu');
const menuButton = document.querySelector('.menu-button');
const menuOptions = document.querySelector('#menuOptions');
const memberSelect = document.querySelector('#memberSelect');
const balanceValue = document.querySelector('#balanceValue');
const transactionsBody = document.querySelector('#transactionsBody');
const importMembersButton = document.querySelector('#importMembersButton');
const memberImportInput = document.querySelector('#memberImportInput');
const transactionDate = document.querySelector('#transactionDate');
const transactionAmount = document.querySelector('#transactionAmount');
const descriptionInput = document.querySelector('textarea');
const undoTransactionButton = document.querySelector('#undoTransactionButton');
const applyTransactionButton = document.querySelector(
  '.footer-actions .button:last-child'
);
const statusBar = document.querySelector('#statusBar');
const statusEmoji = document.querySelector('#statusEmoji');
const statusText = document.querySelector('#statusText');
const loginModal = document.querySelector('#loginModal');
const loginPasswordInput = document.querySelector('#loginPassword');
const loginPasswordConfirmInput = document.querySelector('#loginPasswordConfirm');
const loginCancelButton = document.querySelector('#loginCancel');
const loginConfirmButton = document.querySelector('#loginConfirm');
const confirmImportModal = document.querySelector('#confirmImportModal');
const confirmImportMessage = document.querySelector('#confirmImportMessage');
const confirmImportCancelButton = document.querySelector('#confirmImportCancel');
const confirmImportConfirmButton = document.querySelector('#confirmImportConfirm');
let isLoggedIn = false;
let confirmImportResolver = null;

const setStatus = (message, state = 'success') => {
  statusText.textContent = message;
  statusBar.classList.remove('status-success', 'status-fail');
  statusText.classList.remove('status-success', 'status-fail');
  statusEmoji.classList.remove('status-success', 'status-fail');
  if (state === 'success') {
    statusEmoji.textContent = '✅';
    statusBar.classList.add('status-success');
    statusText.classList.add('status-success');
    statusEmoji.classList.add('status-success');
  } else if (state === 'fail') {
    statusEmoji.textContent = '❌';
    statusBar.classList.add('status-fail');
    statusText.classList.add('status-fail');
    statusEmoji.classList.add('status-fail');
  }
};

setStatus('No connection to database.', 'fail');

const closeMenu = () => {
  menu.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
};

const clearPrivateFields = () => {
  memberSelect.innerHTML = '';
  memberSelect.disabled = true;
  balanceValue.textContent = '$0.00';
  descriptionInput.value = '';
  transactionAmount.value = '';
  transactionDate.value = '';
  renderTransactions([], null);
};

const sendLogoutRequest = () => {
  if (navigator.sendBeacon) {
    const payload = new Blob([], { type: 'text/plain' });
    navigator.sendBeacon('/api/admin/logout', payload);
    return;
  }
  fetch('/api/admin/logout', { method: 'POST', keepalive: true }).catch(() => {});
};

const logout = ({ suppressStatus = false } = {}) => {
  isLoggedIn = false;
  clearPrivateFields();
  renderMenu();
  sendLogoutRequest();
  if (!suppressStatus) {
    setStatus('Logged out.', 'success');
  }
};

const renderMenu = () => {
  menuOptions.innerHTML = '';
  if (!isLoggedIn) {
    const loginButton = document.createElement('button');
    loginButton.type = 'button';
    loginButton.className = 'menu-item';
    loginButton.textContent = 'Login';
    loginButton.addEventListener('click', () => {
      closeMenu();
      handleLogin();
    });
    menuOptions.append(loginButton);
  } else {
    const logoutButton = document.createElement('button');
    logoutButton.type = 'button';
    logoutButton.className = 'menu-item';
    logoutButton.textContent = 'Logout';
    logoutButton.addEventListener('click', () => {
      closeMenu();
      logout();
    });
    menuOptions.append(logoutButton);
  }
};

const handleLogin = () => {
  openLoginModal();
};

menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const isOpen = menu.classList.contains('open');
  if (isOpen) {
    closeMenu();
  } else {
    menu.classList.add('open');
    menuButton.setAttribute('aria-expanded', 'true');
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.window-menu')) {
    closeMenu();
  }
});

const openLoginModal = () => {
  loginPasswordInput.value = '';
  loginPasswordConfirmInput.value = '';
  loginModal.classList.add('open');
  loginPasswordInput.focus();
};

const closeLoginModal = () => {
  loginModal.classList.remove('open');
  loginPasswordInput.value = '';
  loginPasswordConfirmInput.value = '';
};

const openConfirmImportModal = (message) => {
  confirmImportMessage.textContent = message;
  confirmImportModal.classList.add('open');
  confirmImportConfirmButton.focus();
  return new Promise((resolve) => {
    confirmImportResolver = resolve;
  });
};

const closeConfirmImportModal = () => {
  confirmImportModal.classList.remove('open');
  confirmImportMessage.textContent = '';
};

const submitLogin = async () => {
  const enteredPassword = loginPasswordInput.value;
  const confirmedPassword = loginPasswordConfirmInput.value;

  if (!enteredPassword || enteredPassword !== confirmedPassword) {
    setStatus('Password does not match.', 'fail');
    return;
  }

  const response = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: enteredPassword,
      confirmPassword: confirmedPassword,
    }),
  });

  if (!response.ok) {
    setStatus('Login failed.', 'fail');
    return;
  }

  const data = await response.json().catch(() => ({ success: false }));
  if (!data.success) {
    setStatus('Login failed.', 'fail');
    return;
  }

  isLoggedIn = true;
  transactionDate.value = getTodayDate();
  closeLoginModal();
  renderMenu();
  setStatus('Logged in successfully.', 'success');
  await loadMembers();
};

const getTodayDate = () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const dollarsToCents = (value) => {
  const normalized = String(value || '').replace(/[^0-9.-]/g, '').trim();
  if (!normalized) {
    return null;
  }
  const negative = normalized.startsWith('-');
  const [wholePart, fractionalPart = ''] = normalized.replace('-', '').split('.');
  const cents = `${fractionalPart}00`.slice(0, 2);
  const combined = `${wholePart || '0'}${cents}`;
  const parsed = Number.parseInt(combined, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return negative ? -parsed : parsed;
};

const centsToDollars = (cents) => {
  const value = Number(cents);
  if (Number.isNaN(value)) {
    return '0.00';
  }
  const negative = value < 0;
  const absolute = Math.abs(value);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${dollars}.${remainder}`;
};

const formatCurrency = (value) => {
  const cents = dollarsToCents(value);
  const normalized = cents === null ? 0 : cents;
  const formatted = centsToDollars(Math.abs(normalized));
  return `${normalized >= 0 ? '+' : '-'}$${formatted}`;
};

const renderTransactions = (transactions, memberId) => {
  transactionsBody.innerHTML = '';

  const filteredTransactions = memberId
    ? transactions.filter((transaction) => transaction.member_id === memberId)
    : transactions;

  if (!filteredTransactions.length) {
    return;
  }

  filteredTransactions.forEach((transaction) => {
    const row = document.createElement('div');
    row.className = 'table-row';
    const dateValue = String(transaction.date || '').split('T')[0];
    row.innerHTML = `
      <div>${dateValue}</div>
      <div>${transaction.description || ''}</div>
      <div class="amount">${formatCurrency(transaction.amount)}</div>
    `;
    row.addEventListener('click', () => {
      if (row.classList.contains('selected')) {
        row.classList.remove('selected');
        return;
      }
      transactionsBody
        .querySelectorAll('.table-row.selected')
        .forEach((selectedRow) => selectedRow.classList.remove('selected'));
      row.classList.add('selected');
    });
    transactionsBody.appendChild(row);
  });
};

const loadMember = async (memberId, { suppressStatus = false } = {}) => {
  const response = await fetch(`/api/members/${memberId}`);
  if (response.status === 401) {
    handleUnauthorized();
    return;
  }
  if (!response.ok) {
    balanceValue.textContent = '$0.00';
    renderTransactions([], memberId);
    if (!suppressStatus) {
      setStatus('Failed to load transactions.', 'fail');
    }
    return;
  }

  const data = await response.json();
  const balanceCents = dollarsToCents(data.member.balance);
  const balanceText = centsToDollars(balanceCents ?? 0);
  balanceValue.textContent = `$${balanceText.replace('-', '')}`;
  renderTransactions(data.transactions || [], memberId);
  if (!suppressStatus) {
    setStatus(
      data.transactions && data.transactions.length
        ? 'Transactions loaded.'
        : 'No transactions for this member.',
      'success'
    );
  }
};

const applyTransaction = async () => {
  const selectedId = Number(memberSelect.value);
  if (!Number.isInteger(selectedId)) {
    setStatus('Select a member before applying a transaction.', 'fail');
    return;
  }

  const amountCents = dollarsToCents(transactionAmount.value);
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(transactionDate.value);
  const amountValid = amountCents !== null && amountCents > 0;

  if (!dateValid || !amountValid) {
    setStatus('Invalid date or amount.', 'fail');
    return;
  }

  const selectedType = document.querySelector('input[name="type"]:checked');
  const payload = {
    date: transactionDate.value,
    description: descriptionInput.value || '',
    amount: centsToDollars(amountCents),
    type: selectedType?.value || 'charge',
  };

  const response = await fetch(`/api/members/${selectedId}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (response.status === 401) {
    handleUnauthorized();
  } else if (response.ok) {
    await loadMember(selectedId);
    setStatus('Transaction applied successfully.', 'success');
  } else {
    setStatus('Failed to apply transaction.', 'fail');
  }
};

const undoLastTransaction = async () => {
  const selectedId = Number(memberSelect.value);
  if (!Number.isInteger(selectedId)) {
    setStatus('Select a member before undoing.', 'fail');
    return;
  }

  const response = await fetch(`/api/members/${selectedId}/transactions/last`, {
    method: 'DELETE',
  });

  if (response.status === 401) {
    handleUnauthorized();
  } else if (response.ok) {
    await loadMember(selectedId);
    setStatus('Last transaction undone.', 'success');
  } else {
    setStatus('Failed to undo last transaction.', 'fail');
  }
};

const loadMembers = async (
  { suppressStatus = false, preserveSelection = false } = {}
) => {
  const response = await fetch('/api/members');
  if (response.status === 401) {
    handleUnauthorized();
    return;
  }
  if (!response.ok) {
    memberSelect.innerHTML = '<option>No members</option>';
    memberSelect.disabled = true;
    if (!suppressStatus) {
      setStatus('Server or database connection failed.', 'fail');
    }
    return;
  }

  const data = await response.json();
  const previousSelection = preserveSelection ? Number(memberSelect.value) : null;
  memberSelect.innerHTML = '';

  if (!data.members.length) {
    memberSelect.innerHTML = '<option>No members</option>';
    memberSelect.disabled = true;
    balanceValue.textContent = '$0.00';
    renderTransactions([], null);
    if (!suppressStatus) {
      setStatus('No members loaded.', 'fail');
    }
    return;
  }

  data.members.forEach((member) => {
    const option = document.createElement('option');
    option.value = member.id;
    option.textContent = member.displayName;
    memberSelect.appendChild(option);
  });

  const preservedMember = data.members.find(
    (member) => member.id === previousSelection
  );
  const nextMember = preservedMember ?? data.members[0];
  memberSelect.value = nextMember.id;
  memberSelect.disabled = false;
  await loadMember(nextMember.id, { suppressStatus });
  if (!suppressStatus) {
    setStatus('Members loaded successfully.', 'success');
  }
};

const handleSocketMessage = (data) => {
  if (!data || !data.type || !isLoggedIn) {
    return;
  }
  if (data.type === 'membersUpdated') {
    loadMembers({ suppressStatus: true, preserveSelection: true });
  }
  if (data.type === 'memberUpdated') {
    const selectedId = Number(memberSelect.value);
    if (Number.isInteger(selectedId) && selectedId === data.memberId) {
      loadMember(selectedId, { suppressStatus: true });
    }
  }
};

const setupWebSocket = () => {
  const wsUrl = `ws://${window.location.host}`;
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (event) => {
    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      data = null;
    }
    if (data) {
      handleSocketMessage(data);
    }
  });
};

memberSelect.addEventListener('change', (event) => {
  const selectedId = Number(event.target.value);
  if (Number.isInteger(selectedId)) {
    loadMember(selectedId);
  }
});

applyTransactionButton.addEventListener('click', () => {
  applyTransaction();
});

undoTransactionButton.addEventListener('click', () => {
  undoLastTransaction();
});

importMembersButton.addEventListener('click', () => {
  memberImportInput.click();
});

memberImportInput.addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  const previewResponse = await fetch('/api/members/import/preview', {
    method: 'POST',
    body: formData,
  });

  if (previewResponse.status === 401) {
    handleUnauthorized();
    memberImportInput.value = '';
    return;
  }
  if (!previewResponse.ok) {
    memberImportInput.value = '';
    setStatus('Failed to preview import.', 'fail');
    return;
  }

  const previewData = await previewResponse.json();
  if (previewData.toDelete > 0) {
    const confirmed = await openConfirmImportModal(
      `Importing will remove ${previewData.toDelete} member(s) not listed and their transactions. Continue?`
    );
    if (!confirmed) {
      memberImportInput.value = '';
      setStatus('Import cancelled.', 'success');
      return;
    }
  }

  const response = await fetch('/api/members/import', {
    method: 'POST',
    body: formData,
  });

  if (response.status === 401) {
    handleUnauthorized();
  } else if (response.ok) {
    await loadMembers();
    setStatus('Members imported successfully.', 'success');
  } else {
    setStatus('Failed to import members.', 'fail');
  }

  memberImportInput.value = '';
});

const handleUnauthorized = () => {
  isLoggedIn = false;
  clearPrivateFields();
  renderMenu();
  setStatus('Please log in to continue.', 'fail');
};

const initializeSession = async () => {
  try {
    const response = await fetch('/api/admin/session');
    if (!response.ok) {
      throw new Error('Failed to load session.');
    }
    const data = await response.json();
    isLoggedIn = Boolean(data.authenticated);
  } catch (error) {
    isLoggedIn = false;
  }

  if (isLoggedIn) {
    transactionDate.value = getTodayDate();
    renderMenu();
    await loadMembers();
  } else {
    clearPrivateFields();
    renderMenu();
  }
};

loginCancelButton.addEventListener('click', () => {
  closeLoginModal();
});

loginConfirmButton.addEventListener('click', () => {
  submitLogin();
});

confirmImportCancelButton.addEventListener('click', () => {
  if (confirmImportResolver) {
    confirmImportResolver(false);
    confirmImportResolver = null;
  }
  closeConfirmImportModal();
});

confirmImportConfirmButton.addEventListener('click', () => {
  if (confirmImportResolver) {
    confirmImportResolver(true);
    confirmImportResolver = null;
  }
  closeConfirmImportModal();
});

setupWebSocket();
initializeSession();

window.addEventListener('pagehide', () => {
  if (isLoggedIn) {
    logout({ suppressStatus: true });
  }
});
