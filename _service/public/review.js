// Review view. Everything an applicant wrote is placed on the page as text,
// never as markup, so nothing in an application can run in a reviewer's browser.

(function () {
  'use strict';

  const root = document.getElementById('app');
  const who = document.getElementById('who');
  const whoEmail = document.getElementById('who-email');

  const state = {
    config: null,
    me: null,
    view: 'loading', // loading | gate | list
    gateNote: '',
    apps: [],
    labels: { pending: 'Pending review', approved: 'Approved', declined: 'Declined' },
    filter: 'pending',
    query: '',
    open: new Set(),
    kept: new Set(), // just-decided applications stay in view until the filter changes
    drafts: {},
    busy: false,
    error: '',
  };

  const INVITATION_LABELS = { not_sent: 'Not invited', sent: 'Invitation sent', joined: 'Joined Slack' };

  // ---------- helpers ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const day = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
  const fmt = (iso) => (iso ? when.format(new Date(iso)) : '');

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Homology-Review': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || 'request_failed'), { status: res.status, code: data.error });
    return data;
  }

  // Only ever link out to a LinkedIn profile over https.
  function safeProfileUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol === 'https:' && (host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return url.toString();
    } catch (_) { /* fall through */ }
    return null;
  }

  // ---------- data ----------

  async function start() {
    try {
      state.config = await api('GET', '/api/config');
    } catch (_) {
      state.config = { googleClientId: '', devLogin: false, slack: { workspaceUrl: '', invitePeopleUrl: '', integration: 'manual' } };
    }
    try {
      state.me = (await api('GET', '/api/session')).email;
      await load();
    } catch (err) {
      showGate(err.status === 403 ? 'This account is not authorized to review applications.' : '');
    }
  }

  async function load() {
    const data = await api('GET', '/api/applications');
    state.apps = data.applications;
    state.labels = data.statusLabels || state.labels;
    state.view = 'list';
    render();
  }

  function showGate(note) {
    state.me = null;
    state.apps = [];
    state.view = 'gate';
    state.gateNote = note || '';
    render();
  }

  async function act(run) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    render();
    try {
      await run();
    } catch (err) {
      if (err.status === 401) return showGate('Your session ended. Please sign in again.');
      if (err.status === 403) return showGate('This account is not authorized to review applications.');
      state.error = err.message && !/^[a-z_]+$/.test(err.message) ? err.message : 'That did not go through. Please try again.';
    } finally {
      state.busy = false;
      render();
    }
  }

  function replace(updated) {
    const i = state.apps.findIndex((a) => a.id === updated.id);
    if (i >= 0) state.apps[i] = { ...updated, otherApplications: state.apps[i].otherApplications };
  }

  const setStatus = (app, status) =>
    act(async () => {
      replace((await api('POST', `/api/applications/${app.id}/status`, { status })).application);
      state.kept.add(app.id);
    });

  const saveNotes = (app) =>
    act(async () => {
      replace((await api('POST', `/api/applications/${app.id}/notes`, { text: state.drafts[app.id] ?? '' })).application);
      delete state.drafts[app.id];
    });

  const invitation = (app, action) =>
    act(async () => replace((await api('POST', `/api/applications/${app.id}/invitation`, { action })).application));

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch (_) {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  }

  // ---------- sign-in ----------

  async function onCredential(response) {
    try {
      state.me = (await api('POST', '/api/session', { credential: response.credential })).email;
      await load();
    } catch (err) {
      showGate(err.status === 403
        ? 'This Google account is not authorized to review applications.'
        : 'Sign-in did not work. Please try again.');
    }
  }

  function mountGoogle(target) {
    const clientId = state.config.googleClientId;
    if (!clientId) {
      target.append(h('p', { class: 'dev-note' }, 'Google sign-in is not configured on this server.'));
      return;
    }
    const draw = () => {
      window.google.accounts.id.initialize({ client_id: clientId, callback: onCredential, auto_select: false, ux_mode: 'popup' });
      window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular' });
    };
    if (window.google && window.google.accounts) return draw();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = draw;
    script.onerror = () => target.append(h('p', { class: 'dev-note' }, 'Google sign-in could not load. Check your connection and reload.'));
    document.head.append(script);
  }

  function gate() {
    const google = h('div', { class: 'google' });
    const view = h('section', { class: 'gate' },
      state.gateNote ? h('p', { class: 'message', role: 'alert' }, state.gateNote) : null,
      h('h1', {}, 'Sign in to review applications'),
      h('p', {}, 'Use the Google account that has been authorized to review Homology applications. Answers and notes here are private.'),
      google,
    );
    mountGoogle(google);

    if (state.config.devLogin) {
      const input = h('input', { type: 'email', name: 'email', placeholder: 'reviewer email', 'aria-label': 'Reviewer email (local testing)', required: true });
      view.append(
        h('form', {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              state.me = (await api('POST', '/api/dev-session', { email: input.value })).email;
              await load();
            } catch (err) {
              showGate(err.status === 403 ? 'That address is not on the reviewer list.' : 'Sign-in did not work.');
            }
          },
        }, input, h('button', { class: 'btn', type: 'submit' }, 'Local sign-in')),
        h('p', { class: 'dev-note' }, 'Local testing only. This form does not exist in production.'),
      );
    }
    return view;
  }

  // ---------- list ----------

  function matches(app) {
    if (state.filter !== 'all' && app.status !== state.filter && !state.kept.has(app.id)) return false;
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    const a = app.answers;
    return [a.fullName, a.email, a.roleAndOrg, a.city].some((v) => String(v).toLowerCase().includes(q));
  }

  function toolbar() {
    const counts = { pending: 0, approved: 0, declined: 0, all: state.apps.length };
    for (const a of state.apps) counts[a.status] += 1;
    const tabs = [['pending', state.labels.pending], ['approved', state.labels.approved], ['declined', state.labels.declined], ['all', 'All']];
    return h('div', { class: 'toolbar' },
      h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by status' },
        tabs.map(([key, label]) =>
          h('button', {
            type: 'button',
            class: 'filter',
            'data-focus': `filter-${key}`,
            'aria-pressed': String(state.filter === key),
            onclick: () => { state.filter = key; state.kept.clear(); render(); },
          }, label, h('span', { class: 'count' }, counts[key])))),
      h('input', {
        type: 'search',
        class: 'search',
        'data-focus': 'search',
        placeholder: 'Search name, email, organization, city',
        'aria-label': 'Search applications',
        value: state.query,
        oninput: (e) => { state.query = e.target.value; render(); },
      }),
    );
  }

  function emptyState() {
    if (state.apps.length === 0) {
      return h('div', { class: 'empty' },
        h('strong', {}, 'No applications yet.'),
        'When someone applies on homology.bio, their application appears here as pending review.');
    }
    if (state.query.trim()) return h('div', { class: 'empty' }, h('strong', {}, 'No matches.'), 'Try a different search, or switch to All.');
    const messages = {
      pending: ['Nothing is waiting for review.', 'New applications land here first.'],
      approved: ['No approved applications.', 'Approve an application to make its Slack invitation step available.'],
      declined: ['No declined applications.', ''],
    };
    const [title, body] = messages[state.filter] || ['Nothing here.', ''];
    return h('div', { class: 'empty' }, h('strong', {}, title), body);
  }

  function chips(app) {
    const out = [h('span', { class: `chip ${app.status}` }, state.labels[app.status])];
    if (app.status === 'approved' || app.invitation.status !== 'not_sent') {
      out.push(h('span', { class: `chip ${app.invitation.status === 'not_sent' ? 'quiet' : ''}` }, INVITATION_LABELS[app.invitation.status]));
    }
    return out;
  }

  function row(app) {
    const open = state.open.has(app.id);
    const a = app.answers;
    return h('li', { class: 'app' },
      h('button', {
        type: 'button',
        class: 'row',
        'data-focus': `row-${app.id}`,
        'aria-expanded': String(open),
        'aria-controls': `detail-${app.id}`,
        onclick: () => { open ? state.open.delete(app.id) : state.open.add(app.id); render(); },
      },
        h('span', { class: 'row-who' },
          h('span', { class: 'row-name' }, a.fullName),
          h('span', { class: 'row-meta' }, ` · ${a.roleAndOrg} · ${a.city}`)),
        h('span', { class: 'row-side' }, chips(app), h('span', { class: 'row-date' }, day.format(new Date(app.createdAt)))),
      ),
      open ? detail(app) : null,
    );
  }

  // ---------- one application ----------

  function detail(app) {
    const a = app.answers;
    const profile = safeProfileUrl(a.linkedinUrl);
    const copyEmail = h('button', { type: 'button', class: 'link copy', 'data-focus': `copy-${app.id}` }, 'Copy');
    copyEmail.addEventListener('click', () => copy(a.email, copyEmail));

    const answers = [
      ['What are you working on?', a.workingOn],
      ['Who would you most like us to introduce you to?', a.introWish],
      ['What could you help someone else with?', a.canHelpWith],
    ];

    const left = h('div', {},
      h('dl', { class: 'facts' },
        h('dt', {}, 'Email'), h('dd', {}, h('a', { href: `mailto:${encodeURIComponent(a.email).replace(/%40/g, '@')}` }, a.email), copyEmail),
        h('dt', {}, 'LinkedIn'), h('dd', {}, profile ? h('a', { href: profile, target: '_blank', rel: 'noopener noreferrer' }, profile.replace(/^https:\/\/(www\.)?/, '')) : a.linkedinUrl),
        h('dt', {}, 'City'), h('dd', {}, a.city),
        h('dt', {}, 'Role'), h('dd', {}, a.roleAndOrg),
        h('dt', {}, 'Applied'), h('dd', {}, fmt(app.createdAt)),
      ),
      h('div', { class: 'answers' }, answers.map(([q, text]) => h('div', { class: 'answer' }, h('h3', {}, q), h('p', {}, text)))),
      app.otherApplications > 0
        ? h('p', { class: 'also' }, `This email address has ${app.otherApplications} other application${app.otherApplications === 1 ? '' : 's'} on file.`)
        : null,
      history(app),
    );

    return h('div', { class: 'detail', id: `detail-${app.id}` },
      left,
      h('div', {},
        state.error ? h('p', { class: 'message', role: 'alert' }, state.error) : null,
        decisionPanel(app), notesPanel(app), invitationPanel(app)),
    );
  }

  function decisionPanel(app) {
    const button = (label, status, primary) =>
      h('button', {
        type: 'button',
        class: `btn${primary ? ' primary' : ''}`,
        'data-focus': `status-${status}-${app.id}`,
        disabled: state.busy,
        onclick: () => setStatus(app, status),
      }, label);
    const locked = app.invitation.status !== 'not_sent';
    return h('section', { class: 'panel' },
      h('h3', {}, 'Decision'),
      h('div', { class: 'state' }, h('span', { class: `chip ${app.status}` }, state.labels[app.status])),
      h('p', { class: 'meta' }, app.review ? `Reviewed by ${app.review.by} on ${fmt(app.review.at)}.` : 'Not reviewed yet.'),
      locked
        ? h('p', { class: 'meta' }, 'A Slack invitation is on record. To change this decision, revoke the invitation in Slack and clear the record below.')
        : h('div', { class: 'actions' },
            app.status !== 'approved' ? button('Approve', 'approved', true) : null,
            app.status !== 'declined' ? button('Decline', 'declined', false) : null,
            app.status !== 'pending' ? button('Move back to pending', 'pending', false) : null),
    );
  }

  function notesPanel(app) {
    const draft = state.drafts[app.id];
    const value = draft ?? app.notes.text;
    const dirty = draft !== undefined && draft.trim() !== app.notes.text;
    const save = h('button', {
      type: 'button',
      class: 'btn',
      'data-focus': `save-${app.id}`,
      disabled: state.busy || !dirty,
      onclick: () => saveNotes(app),
    }, 'Save notes');
    const area = h('textarea', {
      id: `notes-${app.id}`,
      'data-focus': `notes-${app.id}`,
      maxlength: '5000',
      placeholder: 'Context for other reviewers, who they should meet, anything to follow up on.',
      oninput: (e) => {
        state.drafts[app.id] = e.target.value;
        save.disabled = state.busy || e.target.value.trim() === app.notes.text;
      },
    });
    area.value = value;
    return h('section', { class: 'panel' },
      h('h3', {}, h('label', { for: `notes-${app.id}` }, 'Private notes')),
      h('p', { class: 'meta' }, 'Only reviewers see these. The applicant never does.'),
      area,
      h('div', { class: 'actions' }, save),
      app.notes.updatedAt ? h('p', { class: 'meta' }, `Last edited by ${app.notes.updatedBy} on ${fmt(app.notes.updatedAt)}.`) : null,
    );
  }

  function invitationPanel(app) {
    const inv = app.invitation;
    const slack = state.config.slack;
    const body = [];
    const button = (label, action, primary) =>
      h('button', {
        type: 'button',
        class: `btn${primary ? ' primary' : ''}`,
        'data-focus': `inv-${action}-${app.id}`,
        disabled: state.busy,
        onclick: () => invitation(app, action),
      }, label);

    if (inv.status === 'not_sent' && app.status !== 'approved') {
      body.push(h('p', { class: 'meta' }, 'Available once this application is approved. Applying or being approved never adds anyone to Slack on its own.'));
    } else if (inv.status === 'not_sent') {
      const copyBtn = h('button', { type: 'button', class: 'link copy', 'data-focus': `copyinv-${app.id}` }, 'Copy');
      copyBtn.addEventListener('click', () => copy(app.answers.email, copyBtn));
      body.push(
        h('div', { class: 'state' }, h('span', { class: 'chip quiet' }, INVITATION_LABELS.not_sent)),
        h('p', { class: 'meta' }, 'Slack has no approved way for this tool to send invitations on your plan, so this step is done by hand.'),
        h('ol', { class: 'steps' },
          h('li', {}, h('a', { href: slack.invitePeopleUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open invitations in Slack'), ' and choose Invite people.'),
          h('li', {}, 'Invite this one address as a member: ', h('span', { class: 'address' }, app.answers.email), copyBtn),
          h('li', {}, 'Come back and record it, so the other reviewers know.')),
        h('p', { class: 'meta' }, 'Do not send a shared invite link. Each approved applicant gets an individual invitation.'),
        h('div', { class: 'actions' }, button('Record invitation sent', 'sent', true)),
      );
    } else if (inv.status === 'sent') {
      body.push(
        h('div', { class: 'state' }, h('span', { class: 'chip' }, INVITATION_LABELS.sent)),
        h('p', { class: 'meta' }, `Recorded by ${inv.sentBy} on ${fmt(inv.sentAt)}.`),
        h('div', { class: 'actions' }, button('Mark as joined', 'joined', true), button('Clear record', 'clear', false)),
      );
    } else {
      body.push(
        h('div', { class: 'state' }, h('span', { class: 'chip' }, INVITATION_LABELS.joined)),
        h('p', { class: 'meta' }, `Invited by ${inv.sentBy} on ${fmt(inv.sentAt)}. Joined, recorded by ${inv.joinedRecordedBy} on ${fmt(inv.joinedAt)}.`),
        h('div', { class: 'actions' }, button('Clear record', 'clear', false)),
      );
    }
    return h('section', { class: 'panel' }, h('h3', {}, 'Slack invitation'), body);
  }

  function history(app) {
    const describe = (e) => {
      if (e.action === 'submitted') return 'Application received';
      if (e.action === 'notes') return `${e.by} edited the private notes`;
      if (e.action === 'status') return `${e.by} changed the decision from ${state.labels[e.from].toLowerCase()} to ${state.labels[e.to].toLowerCase()}`;
      if (e.action === 'invitation') return `${e.by} changed the invitation record from ${INVITATION_LABELS[e.from].toLowerCase()} to ${INVITATION_LABELS[e.to].toLowerCase()}`;
      return e.action;
    };
    return h('details', { class: 'history' },
      h('summary', { 'data-focus': `history-${app.id}` }, `History (${app.history.length})`),
      h('ol', {}, app.history.map((e) => h('li', {}, `${fmt(e.at)}: ${describe(e)}`))));
  }

  // ---------- render ----------

  function render() {
    const active = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-focus');
    const caret = active && document.activeElement.selectionStart;

    who.hidden = !state.me;
    whoEmail.textContent = state.me || '';

    if (state.view === 'loading') return;
    if (state.view === 'gate') {
      root.replaceChildren(gate());
      return;
    }

    const visible = state.apps.filter(matches);
    root.replaceChildren(
      toolbar(),
      visible.length ? h('ul', { class: 'apps' }, visible.map(row)) : emptyState(),
    );

    if (active) {
      const again = root.querySelector(`[data-focus="${CSS.escape(active)}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (typeof caret === 'number' && again.setSelectionRange) {
          try { again.setSelectionRange(caret, caret); } catch (_) { /* not a text field */ }
        }
      }
    }
  }

  document.getElementById('sign-out').addEventListener('click', async () => {
    try { await api('DELETE', '/api/session'); } catch (_) { /* signed out either way */ }
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
    showGate('');
  });

  start();
})();
