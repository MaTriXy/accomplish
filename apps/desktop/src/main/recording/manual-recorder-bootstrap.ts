export function buildManualRecorderBootstrap(): string {
  return `
    (() => {
      if (window.__accomplishManualRecorder?.drain) {
        return true;
      }

      const queue = [];
      let lastViewportX = window.scrollX;
      let lastViewportY = window.scrollY;
      let scrollTimer = null;

      const trimText = (value) => {
        if (!value) {
          return '';
        }
        return String(value).replace(/\\s+/g, ' ').trim().slice(0, 120);
      };

      const inferRole = (element) => {
        const explicitRole = element.getAttribute('role');
        if (explicitRole) {
          return explicitRole;
        }
        const tagName = element.tagName.toLowerCase();
        if (tagName === 'button') {
          return 'button';
        }
        if (tagName === 'a' && element.hasAttribute('href')) {
          return 'link';
        }
        if (tagName === 'select') {
          return 'combobox';
        }
        if (tagName === 'textarea') {
          return 'textbox';
        }
        if (tagName === 'input') {
          const type = (element.getAttribute('type') || 'text').toLowerCase();
          if (type === 'checkbox') {
            return 'checkbox';
          }
          if (type === 'radio') {
            return 'radio';
          }
          if (type === 'submit' || type === 'button' || type === 'reset') {
            return 'button';
          }
          return 'textbox';
        }
        return null;
      };

      const getAccessibleName = (element) => {
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) {
          return ariaLabel.trim();
        }
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || '')
            .filter(Boolean)
            .join(' ')
            .trim();
          if (text) {
            return text;
          }
        }
        if ('labels' in element && element.labels) {
          const text = Array.from(element.labels)
            .map((label) => (label.textContent || '').trim())
            .filter(Boolean)
            .join(' ')
            .trim();
          if (text) {
            return text;
          }
        }
        const fallback = [
          element.getAttribute('title'),
          element.getAttribute('placeholder'),
          'value' in element ? String(element.value || '').trim() : '',
          (element.textContent || '').trim(),
        ].find((value) => value && value.trim());
        return fallback ? fallback.trim() : '';
      };

      const buildSelectors = (element) => {
        const selectors = [];
        const selector = trimText(element.getAttribute('data-accomplish-selector'));
        if (selector) {
          selectors.push({ type: 'css', value: selector, confidence: 0.96 });
        }

        const xpath = trimText(element.getAttribute('data-accomplish-xpath'));
        if (xpath) {
          selectors.push({ type: 'xpath', value: xpath, confidence: 0.9 });
        }

        const ref = trimText(element.getAttribute('data-ref'));
        if (ref) {
          selectors.push({ type: 'ref', value: ref, confidence: 0.92 });
        }

        const testId = trimText(element.getAttribute('data-testid'));
        if (testId) {
          selectors.push({ type: 'test-id', value: testId, confidence: 0.93 });
        }

        const ariaLabel = trimText(element.getAttribute('aria-label'));
        if (ariaLabel) {
          selectors.push({ type: 'aria-label', value: ariaLabel, confidence: 0.9 });
        }

        const role = inferRole(element);
        const name = getAccessibleName(element);
        if (role) {
          selectors.push({
            type: 'aria-role',
            value: JSON.stringify({ role, name: name || null }),
            confidence: name ? 0.88 : 0.74,
          });
        }

        const text = trimText(element.textContent);
        if (text) {
          selectors.push({ type: 'text', value: text, confidence: 0.7 });
        }

        return selectors;
      };

      const push = (event) => {
        queue.push({
          ...event,
          timestamp: Date.now(),
          pageUrl: window.location.href,
        });
      };

      document.addEventListener(
        'click',
        (event) => {
          const target = event.target instanceof Element ? event.target.closest('*') : null;
          if (!target) {
            return;
          }
          push({
            kind: 'click',
            selectors: buildSelectors(target),
            button: event.button,
            clickCount: event.detail || 1,
            x: event.clientX,
            y: event.clientY,
          });
        },
        true,
      );

      document.addEventListener(
        'change',
        (event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (!target) {
            return;
          }
          const selectors = buildSelectors(target);
          if (target instanceof HTMLSelectElement) {
            push({
              kind: 'select',
              selectors,
              value: target.value,
            });
            return;
          }
          if (target instanceof HTMLInputElement) {
            const inputType = trimText(target.type).toLowerCase();
            if (inputType === 'file') {
              const files = Array.from(target.files ?? []);
              push({
                kind: 'upload',
                selectors,
                value: JSON.stringify({
                  fileNames: files.map((file) => file.name),
                  mimeTypes: files.map((file) => file.type || 'application/octet-stream'),
                }),
              });
              return;
            }
            if (inputType === 'checkbox' || inputType === 'radio') {
              return;
            }
          }
          if ('value' in target || target.isContentEditable) {
            push({
              kind: 'fill',
              selectors,
              value: target.isContentEditable ? trimText(target.textContent) : String(target.value || ''),
            });
          }
        },
        true,
      );

      document.addEventListener(
        'keydown',
        (event) => {
          if (event.repeat || !event.key) {
            return;
          }
          const target = event.target instanceof Element ? event.target : null;
          push({
            kind: 'keypress',
            selectors: target ? buildSelectors(target) : undefined,
            key: event.key,
            modifiers: [
              event.altKey ? 'Alt' : null,
              event.ctrlKey ? 'Control' : null,
              event.metaKey ? 'Meta' : null,
              event.shiftKey ? 'Shift' : null,
            ].filter(Boolean),
          });
        },
        true,
      );

      window.addEventListener(
        'scroll',
        () => {
          const deltaX = window.scrollX - lastViewportX;
          const deltaY = window.scrollY - lastViewportY;
          lastViewportX = window.scrollX;
          lastViewportY = window.scrollY;
          if (scrollTimer) {
            clearTimeout(scrollTimer);
          }
          scrollTimer = setTimeout(() => {
            if (deltaX === 0 && deltaY === 0) {
              return;
            }
            push({
              kind: 'scroll',
              deltaX,
              deltaY,
            });
            scrollTimer = null;
          }, 120);
        },
        { passive: true },
      );

      window.__accomplishManualRecorder = {
        drain: () => queue.splice(0, queue.length),
      };

      return true;
    })()
  `;
}
