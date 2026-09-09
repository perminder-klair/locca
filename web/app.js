import { reduceEvents } from './events.js';

const $ = (id) => document.getElementById(id);
let sessions = [],
  current = null,
  events = [],
  cursor = 0,
  polling = false,
  generation = 0;
let submitting = false,
  optimisticBusy = false,
  folder = '.',
  lastRender = '';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed: ${response.status}`);
  return result;
}

function error(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      error(e.message);
    }
  };
}

function drawSessions() {
  $('session-count').textContent = sessions.length;
  $('sessions').replaceChildren();
  if (!sessions.length)
    $('sessions').append(node('p', 'Your conversations will appear here.', 'muted'));
  for (const session of sessions) {
    const button = node('button', session.title, session.id === current?.id ? 'active' : '');
    button.append(
      node(
        'small',
        new Date(session.createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        }),
      ),
    );
    button.onclick = guard(() => selectSession(session));
    $('sessions').append(button);
  }
}

async function refreshSessions() {
  sessions = await api('/sessions');
  drawSessions();
}

async function selectSession(session) {
  generation++;
  current = session;
  events = [];
  cursor = 0;
  lastRender = '';
  optimisticBusy = Boolean(session);
  location.hash = session ? session.id : '';
  $('workspace').disabled = Boolean(session);
  if (session) $('workspace').value = session.workspace;
  $('conversation-title').textContent = session?.title || 'A place to get things done.';
  $('welcome').hidden = Boolean(session);
  $('messages').replaceChildren();
  $('approvals').replaceChildren();
  $('file-panel').hidden = true;
  folder = '.';
  drawSessions();
  drawConversation();
  await poll();
}

function drawConversation() {
  const state = reduceEvents(events);
  const key = JSON.stringify([state, optimisticBusy, submitting]);
  if (key === lastRender) return;
  lastRender = key;
  const pane = $('conversation');
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
  const expanded = new Set(
    [...$('messages').querySelectorAll('details[open]')].map((el) => el.dataset.index),
  );
  $('messages').replaceChildren();
  for (const [index, item] of state.items.entries()) {
    if (item.kind === 'tool') {
      const details = node('details', undefined, 'tool');
      details.dataset.index = String(index);
      details.open = expanded.has(String(index));
      details.append(node('summary', `${item.name} · ${item.status}`));
      details.append(node('pre', JSON.stringify(item.input, null, 2)));
      if (item.output !== null)
        details.append(
          node(
            'pre',
            typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2),
          ),
        );
      $('messages').append(details);
    } else if (item.text) {
      const message = node('div', undefined, `message ${item.kind}`);
      message.append(
        node(
          'span',
          item.kind === 'user' ? 'YOU' : item.kind === 'error' ? 'ERROR' : 'LOCCA',
          'message-label',
        ),
      );
      message.append(document.createTextNode(item.text));
      $('messages').append(message);
    }
  }
  const pendingKey = JSON.stringify(state.pending);
  if ($('approvals').dataset.key !== pendingKey) {
    $('approvals').dataset.key = pendingKey;
    $('approvals').replaceChildren();
    for (const request of state.pending) {
      const box = node('section', undefined, 'approval');
      box.append(
        node('h3', request.kind === 'tool-approval' ? 'Allow this command?' : request.prompt),
      );
      if (request.kind === 'tool-approval') {
        box.append(node('p', 'This runs on your host in the attached workspace.', 'muted'));
        box.append(
          node(
            'pre',
            request.action?.input?.command || JSON.stringify(request.action?.input, null, 2),
          ),
        );
      }
      const actions = node('div', undefined, 'actions');
      for (const option of request.options || []) {
        const button = node('button', option.label, option.style === 'primary' ? 'primary' : '');
        button.onclick = guard(async () => {
          button.disabled = true;
          try {
            await respond({ requestId: request.requestId, optionId: option.id });
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      if (request.allowFreeform) {
        const input = node('input');
        input.setAttribute('aria-label', 'Your answer');
        const button = node('button', 'Reply');
        button.onclick = guard(async () => {
          if (input.value.trim())
            await respond({ requestId: request.requestId, text: input.value });
        });
        actions.append(input, button);
      }
      box.append(actions);
      $('approvals').append(box);
    }
  }
  const busy = state.busy || optimisticBusy;
  $('activity').hidden = !current || (!busy && !state.pending.length && !state.terminal);
  $('activity-text').textContent = optimisticBusy ? 'Starting…' : state.status;
  $('cancel').hidden = !current || (!busy && !state.pending.length);
  $('compact').hidden = !current || busy || state.pending.length > 0 || state.terminal;
  $('send').disabled = busy || submitting || state.pending.length > 0 || state.terminal;
  $('prompt').disabled = state.terminal;
  if (nearBottom) pane.scrollTop = pane.scrollHeight;
}

async function poll() {
  if (!current || polling) return;
  polling = true;
  const version = generation,
    id = current.id;
  try {
    const result = await api(`/sessions/${encodeURIComponent(id)}/events?after=${cursor}`);
    if (version !== generation) return;
    if (result.events.length) {
      events.push(...result.events);
      cursor = result.cursor;
      optimisticBusy = false;
    }
    drawConversation();
  } catch (e) {
    if (version === generation) error(`${e.message} Locca will try to reconnect.`);
  } finally {
    polling = false;
  }
}

async function respond(response) {
  await api(`/sessions/${encodeURIComponent(current.id)}/respond`, {
    method: 'POST',
    body: { responses: [response] },
  });
  optimisticBusy = true;
  drawConversation();
  await poll();
}

$('composer').onsubmit = guard(async (event) => {
  event.preventDefault();
  const message = $('prompt').value.trim();
  if (!message || submitting || $('send').disabled) return;
  submitting = true;
  error('');
  drawConversation();
  try {
    if (!current) {
      const session = await api('/sessions', {
        method: 'POST',
        body: { message, workspace: $('workspace').value },
      });
      await refreshSessions();
      await selectSession(session);
    } else {
      await api(`/sessions/${encodeURIComponent(current.id)}/message`, {
        method: 'POST',
        body: { message },
      });
      optimisticBusy = true;
    }
    $('prompt').value = '';
  } finally {
    submitting = false;
    drawConversation();
  }
  await poll();
});
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
};
$('new-session').onclick = guard(() => selectSession(null));
$('cancel').onclick = guard(async () => {
  await api(`/sessions/${encodeURIComponent(current.id)}/cancel`, { method: 'POST', body: {} });
  await poll();
});
$('compact').onclick = guard(async () => {
  await api(`/sessions/${encodeURIComponent(current.id)}/compact`, { method: 'POST', body: {} });
  optimisticBusy = true;
  drawConversation();
});
for (const button of document.querySelectorAll('[data-prompt]'))
  button.onclick = () => {
    $('prompt').value = button.dataset.prompt;
    $('prompt').focus();
  };

async function showFiles(path = '.') {
  if (!current) {
    error('Start a conversation to browse its attached folder.');
    return;
  }
  const files = await api(
    `/sessions/${encodeURIComponent(current.id)}/files?path=${encodeURIComponent(path)}`,
  );
  folder = path;
  $('file-path').textContent = path;
  $('files').replaceChildren();
  $('file-content').hidden = true;
  for (const file of files) {
    const button = node('button', `${file.directory ? '/ ' : ''}${file.name}`);
    button.onclick = guard(async () => {
      if (file.directory) return showFiles(file.path);
      const result = await api(
        `/sessions/${encodeURIComponent(current.id)}/file?path=${encodeURIComponent(file.path)}`,
      );
      $('file-content').textContent = result.content;
      $('file-content').hidden = false;
    });
    $('files').append(button);
  }
  if (!files.length) $('files').append(node('p', 'This folder is empty.', 'muted'));
  $('file-panel').hidden = false;
}
$('files-toggle').onclick = guard(() => showFiles());
$('files-close').onclick = () => {
  $('file-panel').hidden = true;
};
$('file-up').onclick = guard(() => showFiles(folder.split('/').slice(0, -1).join('/') || '.'));

async function refreshJobs() {
  const jobs = await api('/jobs');
  $('job-count').textContent = jobs.length;
  $('jobs-list').replaceChildren();
  for (const job of jobs) {
    const row = node('div', undefined, 'job-row'),
      description = node('div', job.title);
    description.append(
      node(
        'small',
        `Every ${job.intervalMinutes} min · Next ${new Date(job.nextRun).toLocaleString()}`,
      ),
    );
    if (job.error) description.append(node('small', job.error, 'danger'));
    if (job.lastSession) {
      const view = node('button', 'View last run', 'quiet');
      view.onclick = guard(async () => {
        await refreshSessions();
        const session = sessions.find((s) => s.id === job.lastSession);
        if (session) {
          $('jobs-dialog').close();
          await selectSession(session);
        }
      });
      description.append(view);
    }
    const remove = node('button', 'Remove', 'quiet danger');
    remove.onclick = guard(async () => {
      await api(`/jobs/${job.id}`, { method: 'DELETE' });
      await refreshJobs();
    });
    row.append(description, remove);
    $('jobs-list').append(row);
  }
  if (!jobs.length) $('jobs-list').append(node('p', 'No recurring jobs yet.', 'muted'));
}
$('jobs-toggle').onclick = guard(async () => {
  $('job-form').elements.workspace.value = $('workspace').value;
  $('jobs-dialog').showModal();
  await refreshJobs();
});
$('jobs-close').onclick = () => $('jobs-dialog').close();
$('job-form').onsubmit = async (event) => {
  event.preventDefault();
  $('job-error').textContent = '';
  const form = event.currentTarget,
    submit = form.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    values.intervalMinutes = Number(values.intervalMinutes);
    await api('/jobs', { method: 'POST', body: values });
    form.reset();
    form.elements.workspace.value = $('workspace').value;
    await refreshJobs();
  } catch (e) {
    $('job-error').textContent = e.message;
  } finally {
    submit.disabled = false;
  }
};

await guard(async () => {
  const status = await api('/status');
  $('model').textContent = `${status.model} · ${(status.contextWindow / 1024).toFixed(0)}k context`;
  $('workspace').value = new URLSearchParams(location.search).get('workspace') || status.workspace;
  await refreshSessions();
  await refreshJobs();
  const saved = sessions.find((session) => session.id === location.hash.slice(1));
  if (saved) await selectSession(saved);
  setInterval(poll, 1000);
  setInterval(guard(refreshSessions), 15000);
})();
