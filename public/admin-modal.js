'use strict';

function openModal(options) {
  return new Promise(resolve => {
    modalTitle.textContent = options.title || '확인';
    const fields = options.fields || [];
    modalBody.innerHTML = `${options.message ? `<p>${esc(options.message)}</p>` : ''}${options.html || ''}${fields.map(f => {
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea data-modal-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select data-modal-field="${esc(f.name)}">${(f.options || []).map(o => `<option value="${esc(o.value ?? o)}" ${String(o.value ?? o)===String(f.value ?? '')?'selected':''}>${esc(o.label ?? o)}</option>`).join('')}</select></label>`;
      if (f.type === 'password') return `<label>${esc(f.label)}<div class="password-input-row"><input data-modal-field="${esc(f.name)}" type="password" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" inputmode="${esc(f.inputmode || 'numeric')}" autocomplete="new-password" maxlength="${Number(f.maxLength || 8)}"><button type="button" data-modal-reveal="${esc(f.name)}">보기</button></div></label>`;
      return `<label>${esc(f.label)}<input data-modal-field="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
    }).join('')}`;
    modalConfirm.textContent = options.confirmLabel || '확인';
    modalConfirm.className = options.danger ? 'danger' : 'primary';
    modalEl.classList.remove('hidden');
    modalEl.setAttribute('aria-hidden', 'false');

    const close = value => {
      modalEl.classList.add('hidden');
      modalEl.setAttribute('aria-hidden', 'true');
      modalConfirm.onclick = null;
      modalCancel.onclick = null;
      modalBody.onclick = null;
      modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = null);
      resolve(value);
    };
    modalCancel.onclick = () => close(null);
    modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = () => close(null));
    modalBody.onclick = event => {
      const reveal = event.target.closest('[data-modal-reveal]');
      if (!reveal) return;
      const input = modalBody.querySelector(`[data-modal-field="${CSS.escape(reveal.dataset.modalReveal)}"]`);
      if (!input) return;
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      reveal.textContent = visible ? '보기' : '숨기기';
      input.focus();
    };
    modalConfirm.onclick = () => {
      const values = {};
      modalBody.querySelectorAll('[data-modal-field]').forEach(el => values[el.dataset.modalField] = el.value);
      close(values);
    };
    const first = modalBody.querySelector('input,textarea,select');
    if (first) setTimeout(() => first.focus(), 20);
  });
}

