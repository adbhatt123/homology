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
    labels: { pending: 'Pending review', call: 'Intro call', approved: 'Approved', declined: 'Declined' },
    filter: 'pending',
    query: '',
    open: new Set(),
    kept: new Set(), // just-decided applications stay in view until the filter changes
    drafts: {},
    busy: false,
    error: '',

    // Introductions between approved members.
    section: 'applications', // applications | introductions
    intros: [],
    introLabels: { suggested: 'Suggested', asked: 'Both asked', made: 'Made', happened: 'Happened', dropped: 'Dropped' },
    introForm: null,
    introOpen: new Set(),
    owedOpen: new Set(),
    introDrafts: {},
  };

  const blankIntro = () => ({ forId: '', other: 'member', withId: '', outsideName: '', outsideAbout: '', reason: '', status: 'suggested' });
  state.introForm = blankIntro();

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
      state.config = { googleClientId: '', devLogin: false, slack: { workspaceUrl: '', invitePeopleUrl: '', integration: 'manual' }, call: { bookingLinkSet: false }, receipt: { on: false } };
    }
    try {
      state.me = (await api('GET', '/api/session')).email;
      await load();
    } catch (err) {
      showGate(err.status === 403 ? 'This account is not authorized to review applications.' : '');
    }
  }

  async function load() {
    const [data, intro] = await Promise.all([api('GET', '/api/applications'), api('GET', '/api/introductions')]);
    state.apps = data.applications;
    state.labels = data.statusLabels || state.labels;
    state.intros = intro.introductions;
    state.introLabels = intro.statusLabels || state.introLabels;
    state.view = 'list';
    render();
  }

  function showGate(note) {
    state.me = null;
    state.apps = [];
    state.intros = [];
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

  const callInvite = (app, action) =>
    act(async () => replace((await api('POST', `/api/applications/${app.id}/call`, { action })).application));

  const decisionEmail = (app, kind, action) =>
    act(async () => replace((await api('POST', `/api/applications/${app.id}/email`, { kind, action })).application));

  // Only ever open a draft in Gmail.
  function safeDraftUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'mail.google.com') return url.toString();
    } catch (_) { /* fall through */ }
    return null;
  }

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
    const counts = { pending: 0, call: 0, approved: 0, declined: 0, all: state.apps.length };
    for (const a of state.apps) counts[a.status] = (counts[a.status] || 0) + 1;
    const tabs = [['pending', state.labels.pending], ['call', state.labels.call], ['approved', state.labels.approved], ['declined', state.labels.declined], ['all', 'All']];
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
      call: ['Nobody is at the call stage.', 'Move an application to a call to invite that person to a short intro call before deciding.'],
      approved: ['No approved applications.', 'Approve an application to make its Slack invitation step available.'],
      declined: ['No declined applications.', ''],
    };
    const [title, body] = messages[state.filter] || ['Nothing here.', ''];
    return h('div', { class: 'empty' }, h('strong', {}, title), body);
  }

  // The form's hidden spam-check field was filled in (see README, "The spam check").
  function tripped(app) {
    return Boolean(app.spamCheck && app.spamCheck.tripped);
  }

  function chips(app) {
    const out = [h('span', { class: `chip ${app.status}` }, state.labels[app.status])];
    if (tripped(app)) out.push(h('span', { class: 'chip warn' }, 'Check for spam'));
    if (app.status === 'call') {
      out.push(h('span', { class: `chip ${app.call.inviteSentAt ? '' : 'quiet'}` }, app.call.inviteSentAt ? 'Call invite sent' : 'Call invite not sent'));
    }
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
      tripped(app)
        ? h('p', { class: 'spam-check' },
            h('strong', {}, 'Check this one before you trust it. '),
            "It filled in a field on the form that people can't see. That is usually a bot, but a browser's autofill can do it for a real person too. It was kept so you can decide. No receipt email was sent.")
        : null,
      h('dl', { class: 'facts' },
        h('dt', {}, 'Email'), h('dd', {}, h('a', { href: `mailto:${encodeURIComponent(a.email).replace(/%40/g, '@')}` }, a.email), copyEmail),
        h('dt', {}, 'LinkedIn'), h('dd', {}, profile ? h('a', { href: profile, target: '_blank', rel: 'noopener noreferrer' }, profile.replace(/^https:\/\/(www\.)?/, '')) : a.linkedinUrl),
        h('dt', {}, 'City'), h('dd', {}, a.city),
        h('dt', {}, 'Role'), h('dd', {}, a.roleAndOrg),
        h('dt', {}, 'Applied'), h('dd', {}, fmt(app.createdAt)),
        // The automatic "we got it" email. Shown once it exists, or when it should have gone out and did not.
        app.receipt && app.receipt.sentAt
          ? [h('dt', {}, 'Receipt'), h('dd', {}, `Emailed to them ${fmt(app.receipt.sentAt)}`)]
          : state.config.receipt && state.config.receipt.on
            ? [h('dt', {}, 'Receipt'), h('dd', {}, tripped(app) ? 'Not emailed, because of the spam check' : 'Not emailed')]
            : null,
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
        decisionPanel(app), callPanel(app), notesPanel(app), emailPanel(app, 'decline'), emailPanel(app, 'welcome'), invitationPanel(app)),
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
    const by = app.review ? `${app.review.by} on ${fmt(app.review.at)}` : '';
    const reviewed = !app.review ? 'Not reviewed yet.'
      : app.status === 'call' ? `Moved to a call by ${by}.`
      : app.status === 'pending' ? `Moved back to pending by ${by}.`
      : `Reviewed by ${by}.`;
    return h('section', { class: 'panel' },
      h('h3', {}, 'Decision'),
      h('div', { class: 'state' }, h('span', { class: `chip ${app.status}` }, state.labels[app.status])),
      h('p', { class: 'meta' }, reviewed),
      locked
        ? h('p', { class: 'meta' }, 'A Slack invitation is on record. To change this decision, revoke the invitation in Slack and clear the record below.')
        : h('div', { class: 'actions' },
            app.status === 'pending' ? button('Move to call', 'call', true) : null,
            app.status !== 'approved'
              ? button(
                  app.status === 'pending' ? 'Approve without a call' : 'Approve',
                  'approved',
                  // One step stands out at a time: at the call stage that is the invite, until it has gone out.
                  app.status === 'call' && Boolean(app.call.inviteSentAt))
              : null,
            app.status !== 'declined' ? button('Decline', 'declined', false) : null,
            app.status !== 'pending' ? button('Move back to pending', 'pending', false) : null),
    );
  }

  // The intro call: a short email invite the reviewer sends from their own
  // inbox, then records here. Shown at the call stage, and afterwards as a
  // one-line record if an invite went out.
  function callPanel(app) {
    const call = app.call;
    if (app.status !== 'call' && !call.inviteSentAt) return null;
    const button = (label, action, primary) =>
      h('button', {
        type: 'button',
        class: `btn${primary ? ' primary' : ''}`,
        'data-focus': `call-${action}-${app.id}`,
        disabled: state.busy,
        onclick: () => callInvite(app, action),
      }, label);
    const body = [];

    if (call.inviteSentAt) {
      body.push(
        h('div', { class: 'state' }, h('span', { class: 'chip' }, 'Call invite sent')),
        h('p', { class: 'meta' }, `Recorded by ${call.inviteSentBy} on ${fmt(call.inviteSentAt)}.`),
      );
      if (app.status === 'call') {
        body.push(
          h('p', { class: 'meta' }, 'After the call, add what you learned to the private notes, then approve or decline above.'),
          h('div', { class: 'actions' }, button('Clear record', 'clear', false)),
        );
      }
    } else {
      const draft = safeDraftUrl(app.callInviteUrl);
      body.push(
        h('div', { class: 'state' }, h('span', { class: 'chip quiet' }, 'Call invite not sent')),
        h('ol', { class: 'steps' },
          h('li', {},
            draft
              ? h('a', { href: draft, target: '_blank', rel: 'noopener noreferrer', 'data-focus': `call-draft-${app.id}` }, 'Write the invite in Gmail')
              : 'Write a short invite',
            ' to ', h('span', { class: 'address' }, app.answers.email), '. It opens as a draft you can edit before sending.'),
          h('li', {}, 'Come back and record it, so the other reviewers know.')),
        h('p', { class: 'meta' }, state.config.call && state.config.call.bookingLinkSet
          ? 'The draft includes the booking link.'
          : 'No booking link is set yet, so the draft asks them to suggest a couple of times.'),
        h('p', { class: 'meta' }, 'A call adds nobody to Slack. That still takes an approval and an invitation.'),
        h('div', { class: 'actions' }, button('Record call invite sent', 'sent', true)),
      );
    }
    return h('section', { class: 'panel' }, h('h3', {}, 'Intro call'), body);
  }

  // The email that follows a decision: a welcome after an approval, a short
  // note after a decline. The reviewer sends it from their own inbox, then
  // records it here. If the decision changes afterwards the record stays,
  // because the email did go out.
  const DECISION_EMAILS = {
    welcome: {
      title: 'Welcome email',
      status: 'approved',
      write: 'Write the welcome email in Gmail',
      record: 'Record welcome email sent',
      hint: 'It tells them a Slack invitation follows, so send it before or right after you invite them.',
    },
    decline: {
      title: 'Decline email',
      status: 'declined',
      write: 'Write the decline email in Gmail',
      record: 'Record decline email sent',
      hint: 'It is short and gives no reason. Add one in the draft if you want to.',
    },
  };

  function emailPanel(app, kind) {
    const spec = DECISION_EMAILS[kind];
    const email = app.emails[kind];
    const current = app.status === spec.status;
    if (!current && !email.sentAt) return null;
    const button = (label, action, primary) =>
      h('button', {
        type: 'button',
        class: `btn${primary ? ' primary' : ''}`,
        'data-focus': `email-${kind}-${action}-${app.id}`,
        disabled: state.busy,
        onclick: () => decisionEmail(app, kind, action),
      }, label);
    const body = [];

    if (email.sentAt) {
      body.push(
        h('div', { class: 'state' }, h('span', { class: 'chip' }, 'Sent')),
        h('p', { class: 'meta' }, `Recorded by ${email.sentBy} on ${fmt(email.sentAt)}.`),
        current ? null : h('p', { class: 'meta' }, 'This went out before the decision changed.'),
        h('div', { class: 'actions' }, button('Clear record', 'clear', false)),
      );
    } else {
      const draft = safeDraftUrl(app.emailUrls && app.emailUrls[kind]);
      body.push(
        h('div', { class: 'state' }, h('span', { class: 'chip quiet' }, 'Not sent')),
        h('ol', { class: 'steps' },
          h('li', {},
            draft
              ? h('a', { href: draft, target: '_blank', rel: 'noopener noreferrer', 'data-focus': `email-${kind}-draft-${app.id}` }, spec.write)
              : 'Write a short email',
            ' to ', h('span', { class: 'address' }, app.answers.email), '. It opens as a draft you can edit before sending.'),
          h('li', {}, 'Come back and record it, so the other reviewers know.')),
        h('p', { class: 'meta' }, spec.hint),
        h('div', { class: 'actions' }, button(spec.record, 'sent', true)),
      );
    }
    return h('section', { class: 'panel' }, h('h3', {}, spec.title), body);
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
        // One step stands out at a time: the welcome email first, then the invitation.
        h('div', { class: 'actions' }, button('Record invitation sent', 'sent', Boolean(app.emails.welcome.sentAt))),
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
      if (e.action === 'submitted') return e.spamCheck ? 'Application received, with the hidden spam-check field filled in' : 'Application received';
      if (e.action === 'receipt') return 'Receipt emailed to the applicant';
      if (e.action === 'notes') return `${e.by} edited the private notes`;
      if (e.action === 'status') return `${e.by} changed the decision from ${state.labels[e.from].toLowerCase()} to ${state.labels[e.to].toLowerCase()}`;
      if (e.action === 'invitation') return `${e.by} changed the invitation record from ${INVITATION_LABELS[e.from].toLowerCase()} to ${INVITATION_LABELS[e.to].toLowerCase()}`;
      if (e.action === 'call_invite') return e.to === 'sent' ? `${e.by} recorded the call invite as sent` : `${e.by} cleared the call invite record`;
      if (e.action === 'email') return e.to === 'sent' ? `${e.by} recorded the ${e.kind} email as sent` : `${e.by} cleared the ${e.kind} email record`;
      return e.action;
    };
    return h('details', { class: 'history' },
      h('summary', { 'data-focus': `history-${app.id}` }, `History (${app.history.length})`),
      h('ol', {}, app.history.map((e) => h('li', {}, `${fmt(e.at)}: ${describe(e)}`))));
  }

  // ---------- introductions ----------
  //
  // Who has been introduced to whom. Nothing here contacts anyone: a reviewer
  // makes the introduction themselves and records it.

  const INTRO_DONE = new Set(['made', 'happened']);
  const INTRO_NEXT = { suggested: 'asked', asked: 'made', made: 'happened' };
  const INTRO_ACTIONS = { suggested: 'Back to suggested', asked: 'Both asked', made: 'Made', happened: 'Happened', dropped: 'Drop' };
  const INTRO_CHIP = { suggested: 'quiet', asked: '', made: 'approved', happened: 'approved', dropped: 'declined' };

  const appById = (id) => state.apps.find((a) => a.id === id);
  const nameOf = (id) => { const a = appById(id); return a ? a.answers.fullName : 'Someone no longer on file'; };
  const otherName = (intro) => (intro.withId ? nameOf(intro.withId) : `${intro.outside.name} (outside Homology)`);
  const approvedAt = (a) => (a.review && a.review.at) || a.createdAt;
  const members = () => state.apps
    .filter((a) => a.status === 'approved')
    .sort((a, b) => a.answers.fullName.localeCompare(b.answers.fullName));

  // Approved members nobody has been introduced to yet, longest wait first.
  function owed() {
    const introduced = new Set();
    for (const i of state.intros) {
      if (!INTRO_DONE.has(i.status)) continue;
      introduced.add(i.forId);
      if (i.withId) introduced.add(i.withId);
    }
    return members().filter((m) => !introduced.has(m.id)).sort((a, b) => (approvedAt(a) < approvedAt(b) ? -1 : 1));
  }

  // A rough guide only: other members whose answers share words with what
  // this person asked for. It runs in the browser and sends nothing anywhere.
  const COMMON = new Set(('about above after again also another because been before being between both could does doing down during each '
    + 'from further have having here into just like more most much need only other over same should some such than that their them then '
    + 'there these they this those through under until very want what when where which while will with within would your yours people '
    + 'someone anyone work working works building build help meet looking interested would').split(' '));
  const wordsIn = (text) => new Set((String(text || '').toLowerCase().match(/[a-z\u00c0-\u024f][a-z\u00c0-\u024f-]{3,}/g) || []).filter((w) => !COMMON.has(w)));
  function fitsFor(member) {
    const wants = wordsIn(`${member.answers.introWish} ${member.answers.workingOn}`);
    return members()
      .filter((m) => m.id !== member.id)
      .map((m) => {
        const has = wordsIn(`${m.answers.canHelpWith} ${m.answers.roleAndOrg} ${m.answers.workingOn}`);
        return { member: m, shared: [...wants].filter((w) => has.has(w)) };
      })
      .filter((f) => f.shared.length >= 2) // one shared word is noise
      .sort((a, b) => b.shared.length - a.shared.length)
      .slice(0, 3);
  }

  const replaceIntro = (updated) => {
    const i = state.intros.findIndex((x) => x.id === updated.id);
    if (i >= 0) state.intros[i] = updated;
  };

  const recordIntro = () =>
    act(async () => {
      const f = state.introForm;
      const body = { forId: f.forId, reason: f.reason, status: f.status };
      if (f.other === 'member') body.withId = f.withId;
      else body.outside = { name: f.outsideName, about: f.outsideAbout };
      const created = (await api('POST', '/api/introductions', body)).introduction;
      state.intros.unshift(created);
      state.introOpen.add(created.id);
      state.introForm = blankIntro();
    });

  const setIntroStatus = (intro, status) =>
    act(async () => replaceIntro((await api('POST', `/api/introductions/${intro.id}/status`, { status })).introduction));

  const saveIntroReason = (intro) =>
    act(async () => {
      replaceIntro((await api('POST', `/api/introductions/${intro.id}/reason`, { text: state.introDrafts[intro.id] ?? '' })).introduction);
      delete state.introDrafts[intro.id];
    });

  // Fills the form for one member and brings it into view.
  function startIntro(forId, withId) {
    state.introForm = { ...blankIntro(), forId, withId: withId || '' };
    state.error = '';
    render();
    const form = document.getElementById('intro-form');
    if (form) form.scrollIntoView({ block: 'start' });
    const next = document.getElementById(withId ? 'intro-reason' : 'intro-with');
    if (next) next.focus({ preventScroll: true });
  }

  function introFormPanel() {
    const f = state.introForm;
    const all = members();
    const memberSelect = (id, key, exclude) => {
      const select = h('select', { id, 'data-focus': id, onchange: (e) => { f[key] = e.target.value; render(); } },
        h('option', { value: '' }, 'Choose a member'),
        all.filter((m) => m.id !== exclude).map((m) => h('option', { value: m.id }, `${m.answers.fullName} · ${m.answers.roleAndOrg}`)));
      select.value = all.some((m) => m.id === f[key] && m.id !== exclude) ? f[key] : '';
      return select;
    };
    const textInput = (id, key, attrs) => {
      const input = h('input', { type: 'text', id, 'data-focus': id, oninput: (e) => { f[key] = e.target.value; }, ...attrs });
      input.value = f[key];
      return input;
    };
    const choice = (value, text) => {
      const radio = h('input', { type: 'radio', name: 'intro-other', id: `intro-other-${value}`, 'data-focus': `intro-other-${value}`, onchange: () => { f.other = value; render(); } });
      radio.checked = f.other === value;
      return h('label', { class: 'option', for: `intro-other-${value}` }, radio, text);
    };
    const reason = h('textarea', {
      id: 'intro-reason',
      'data-focus': 'intro-reason',
      maxlength: '1000',
      placeholder: 'What each of them gets out of it. Only reviewers see this.',
      oninput: (e) => { f.reason = e.target.value; },
    });
    reason.value = f.reason;
    const status = h('select', { id: 'intro-status', 'data-focus': 'intro-status', onchange: (e) => { f.status = e.target.value; } },
      ['suggested', 'asked', 'made', 'happened'].map((key) => h('option', { value: key }, state.introLabels[key])));
    status.value = f.status;

    return h('section', { class: 'panel intro-form', id: 'intro-form' },
      h('h2', {}, 'Record an introduction'),
      h('p', { class: 'meta' }, 'This records it for you and the other reviewers. It does not contact anyone: you make the introduction yourself.'),
      h('div', { class: 'fields' },
        h('div', { class: 'field' }, h('label', { for: 'intro-for' }, 'For'), memberSelect('intro-for', 'forId', '')),
        h('fieldset', { class: 'field choice' },
          h('legend', {}, 'Introduce them to'),
          choice('member', 'Another member'),
          choice('outside', 'Someone outside Homology')),
        f.other === 'member'
          ? h('div', { class: 'field' }, h('label', { for: 'intro-with' }, 'Member'), memberSelect('intro-with', 'withId', f.forId))
          : [
              h('div', { class: 'field' }, h('label', { for: 'intro-outside-name' }, 'Their name'), textInput('intro-outside-name', 'outsideName', { maxlength: '120' })),
              h('div', { class: 'field' }, h('label', { for: 'intro-outside-about' }, 'Who they are'), textInput('intro-outside-about', 'outsideAbout', { maxlength: '200', placeholder: 'Role and organization' })),
            ],
        h('div', { class: 'field wide' }, h('label', { for: 'intro-reason' }, 'Why they should meet'), reason),
        h('div', { class: 'field' }, h('label', { for: 'intro-status' }, 'Where it stands'), status)),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', 'data-focus': 'intro-record', disabled: state.busy, onclick: recordIntro }, 'Record introduction')));
  }

  function owedRow(m) {
    const open = state.owedOpen.has(m.id);
    const a = m.answers;
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(approvedAt(m))) / 86400000));
    const underway = state.intros.filter((i) => ['suggested', 'asked'].includes(i.status) && (i.forId === m.id || i.withId === m.id)).length;
    return h('li', { class: 'app' },
      h('button', {
        type: 'button',
        class: 'row',
        'data-focus': `owed-${m.id}`,
        'aria-expanded': String(open),
        onclick: () => { open ? state.owedOpen.delete(m.id) : state.owedOpen.add(m.id); render(); },
      },
        h('span', { class: 'row-who' },
          h('span', { class: 'row-name' }, a.fullName),
          h('span', { class: 'row-meta' }, ` · ${a.roleAndOrg} · ${a.city}`)),
        h('span', { class: 'row-side' },
          underway ? h('span', { class: 'chip quiet' }, `${underway} under way`) : null,
          h('span', { class: 'row-date' }, days === 0 ? 'approved today' : `approved ${days} day${days === 1 ? '' : 's'} ago`))),
      open ? owedDetail(m) : null);
  }

  function owedDetail(m) {
    const a = m.answers;
    const fits = fitsFor(m);
    const asked = [
      ['Who they asked to meet', a.introWish],
      ['What they can help with', a.canHelpWith],
      ['What they are working on', a.workingOn],
    ];
    return h('div', { class: 'detail' },
      h('div', { class: 'answers flush' }, asked.map(([q, text]) => h('div', { class: 'answer' }, h('h3', {}, q), h('p', {}, text)))),
      h('div', {},
        h('section', { class: 'panel' },
          h('h3', {}, 'Possible fits'),
          h('p', { class: 'meta' }, 'Other members whose answers share words with what this person asked for. A rough guide, not a recommendation.'),
          fits.length
            ? h('ul', { class: 'fits' }, fits.map((f) => h('li', {},
                h('span', { class: 'fit-who' }, h('strong', {}, f.member.answers.fullName), ` · ${f.member.answers.roleAndOrg}`),
                h('span', { class: 'meta' }, `Shared words: ${f.shared.slice(0, 6).join(', ')}`),
                h('button', { type: 'button', class: 'link', 'data-focus': `fit-${m.id}-${f.member.id}`, onclick: () => startIntro(m.id, f.member.id) }, 'Introduce them'))))
            : h('p', { class: 'meta' }, 'No obvious fit among the current members.'),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn', 'data-focus': `owed-start-${m.id}`, onclick: () => startIntro(m.id, '') }, 'Record an introduction for them')))));
  }

  function introRow(intro) {
    const open = state.introOpen.has(intro.id);
    return h('li', { class: 'app' },
      h('button', {
        type: 'button',
        class: 'row',
        'data-focus': `intro-${intro.id}`,
        'aria-expanded': String(open),
        onclick: () => { open ? state.introOpen.delete(intro.id) : state.introOpen.add(intro.id); render(); },
      },
        h('span', { class: 'row-who' }, h('span', { class: 'row-name' }, `${nameOf(intro.forId)} and ${otherName(intro)}`)),
        h('span', { class: 'row-side' },
          h('span', { class: `chip ${INTRO_CHIP[intro.status]}` }, state.introLabels[intro.status]),
          h('span', { class: 'row-date' }, day.format(new Date(intro.updatedAt))))),
      open ? introDetail(intro) : null);
  }

  function introDetail(intro) {
    const person = (id) => {
      const a = appById(id);
      return a ? `${a.answers.fullName} · ${a.answers.roleAndOrg}` : 'Someone no longer on file';
    };
    const draft = state.introDrafts[intro.id];
    const save = h('button', {
      type: 'button',
      class: 'btn',
      'data-focus': `intro-save-${intro.id}`,
      disabled: state.busy || draft === undefined || draft.trim() === intro.reason,
      onclick: () => saveIntroReason(intro),
    }, 'Save');
    const area = h('textarea', {
      id: `intro-reason-${intro.id}`,
      'data-focus': `intro-reason-${intro.id}`,
      maxlength: '1000',
      oninput: (e) => {
        state.introDrafts[intro.id] = e.target.value;
        save.disabled = state.busy || e.target.value.trim() === intro.reason;
      },
    });
    area.value = draft ?? intro.reason;
    const describe = (e) => {
      if (e.action === 'created') return `${e.by} recorded it as ${state.introLabels[e.to].toLowerCase()}`;
      if (e.action === 'status') return `${e.by} moved it from ${state.introLabels[e.from].toLowerCase()} to ${state.introLabels[e.to].toLowerCase()}`;
      if (e.action === 'reason') return `${e.by} edited the reason`;
      return e.action;
    };
    const next = INTRO_NEXT[intro.status];
    return h('div', { class: 'detail' },
      h('div', {},
        h('dl', { class: 'facts' },
          h('dt', {}, 'For'), h('dd', {}, person(intro.forId)),
          h('dt', {}, 'With'), h('dd', {}, intro.withId ? person(intro.withId) : `${intro.outside.name}${intro.outside.about ? ` · ${intro.outside.about}` : ''} (outside Homology)`)),
        h('div', { class: 'field wide spaced' },
          h('label', { for: `intro-reason-${intro.id}` }, 'Why they should meet'),
          area,
          h('div', { class: 'actions' }, save)),
        h('details', { class: 'history' },
          h('summary', { 'data-focus': `intro-history-${intro.id}` }, `History (${intro.history.length})`),
          h('ol', {}, intro.history.map((e) => h('li', {}, `${fmt(e.at)}: ${describe(e)}`))))),
      h('div', {},
        h('section', { class: 'panel' },
          h('h3', {}, 'Where it stands'),
          h('div', { class: 'state' }, h('span', { class: `chip ${INTRO_CHIP[intro.status]}` }, state.introLabels[intro.status])),
          h('p', { class: 'meta' }, `Recorded by ${intro.createdBy} on ${fmt(intro.createdAt)}.${intro.updatedAt !== intro.createdAt ? ` Last changed by ${intro.updatedBy} on ${fmt(intro.updatedAt)}.` : ''}`),
          h('div', { class: 'actions' },
            Object.keys(INTRO_ACTIONS).filter((key) => key !== intro.status).map((key) =>
              h('button', {
                type: 'button',
                class: `btn${key === next ? ' primary' : ''}`,
                'data-focus': `intro-${key}-${intro.id}`,
                disabled: state.busy,
                onclick: () => setIntroStatus(intro, key),
              }, INTRO_ACTIONS[key]))))));
  }

  function introductionsView() {
    if (members().length === 0) {
      return [h('div', { class: 'empty' },
        h('strong', {}, 'No members yet.'),
        'Introductions start once an application is approved. Approved members appear here with who they asked to meet.')];
    }
    const waiting = owed();
    return [
      state.error ? h('p', { class: 'message', role: 'alert' }, state.error) : null,
      introFormPanel(),
      h('section', { class: 'block' },
        h('h2', {}, 'Owed an introduction', h('span', { class: 'count' }, waiting.length)),
        h('p', { class: 'meta' }, 'Approved members nobody has been introduced to yet, longest wait first. An introduction counts once it is made.'),
        waiting.length ? h('ul', { class: 'apps' }, waiting.map(owedRow)) : h('p', { class: 'meta' }, 'Every approved member has had at least one introduction.')),
      h('section', { class: 'block' },
        h('h2', {}, 'Introductions', h('span', { class: 'count' }, state.intros.length)),
        state.intros.length ? h('ul', { class: 'apps' }, state.intros.map(introRow)) : h('p', { class: 'meta' }, 'None recorded yet.')),
    ];
  }

  function sections() {
    const tabs = [['applications', 'Applications', state.apps.length], ['introductions', 'Introductions', state.intros.length]];
    return h('nav', { class: 'views', 'aria-label': 'Sections' },
      tabs.map(([key, label, count]) =>
        h('button', {
          type: 'button',
          class: 'view',
          'data-focus': `view-${key}`,
          'aria-pressed': String(state.section === key),
          onclick: () => { state.section = key; state.error = ''; render(); },
        }, label, h('span', { class: 'count' }, count))));
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
    const body = state.section === 'introductions'
      ? introductionsView()
      : [toolbar(), visible.length ? h('ul', { class: 'apps' }, visible.map(row)) : emptyState()];
    root.replaceChildren(sections(), ...body.filter(Boolean));

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
