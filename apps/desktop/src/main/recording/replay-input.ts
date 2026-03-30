import { CdpClient } from './cdp-client';
import type { Point } from './replay-types';

function getMouseButtonMask(button: 'left' | 'middle' | 'right'): number {
  if (button === 'right') {
    return 2;
  }
  if (button === 'middle') {
    return 4;
  }
  return 1;
}

export async function dispatchMouseClick(
  cdp: CdpClient,
  sessionId: string,
  point: Point,
  button: 'left' | 'middle' | 'right',
  clickCount: number,
): Promise<void> {
  const normalizedClickCount = Math.max(1, clickCount);
  const buttonMask = getMouseButtonMask(button);

  await cdp.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    },
    sessionId,
  );

  for (let index = 0; index < normalizedClickCount; index += 1) {
    await cdp.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        buttons: buttonMask,
        clickCount: index + 1,
      },
      sessionId,
    );
    await cdp.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        buttons: 0,
        clickCount: index + 1,
      },
      sessionId,
    );
  }
}

function getCdpModifiers(modifiers: string[]): number {
  const normalizedModifiers = modifiers.map((modifier) => modifier.toLowerCase());
  let value = 0;
  if (normalizedModifiers.includes('alt')) {
    value |= 1;
  }
  if (normalizedModifiers.includes('control') || normalizedModifiers.includes('ctrl')) {
    value |= 2;
  }
  if (
    normalizedModifiers.includes('meta') ||
    normalizedModifiers.includes('command') ||
    normalizedModifiers.includes('cmd')
  ) {
    value |= 4;
  }
  if (normalizedModifiers.includes('shift')) {
    value |= 8;
  }
  return value;
}

function getKeyDefinition(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
} {
  const knownKeys: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> =
    {
      Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Tab: { code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
      Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
      ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
      Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
      ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    };
  const known = knownKeys[key];
  if (known) {
    return { key, ...known };
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const charCode = upper.charCodeAt(0);
    const isDigit = /[0-9]/.test(key);
    return {
      key,
      code: isDigit ? `Digit${key}` : `Key${upper}`,
      windowsVirtualKeyCode: charCode,
      text: key,
    };
  }
  return {
    key,
    code: key,
    windowsVirtualKeyCode: 0,
  };
}

export async function dispatchKeyboardInput(
  cdp: CdpClient,
  sessionId: string,
  key: string,
  modifiers: string[],
): Promise<void> {
  const definition = getKeyDefinition(key);
  const cdpModifiers = getCdpModifiers(modifiers);
  const shouldSendText = Boolean(definition.text) && (cdpModifiers & (1 | 2 | 4)) === 0;

  await cdp.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: shouldSendText ? 'keyDown' : 'rawKeyDown',
      key: definition.key,
      code: definition.code,
      text: shouldSendText ? definition.text : undefined,
      unmodifiedText: shouldSendText ? definition.text : undefined,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: cdpModifiers,
    },
    sessionId,
  );
  await cdp.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: cdpModifiers,
    },
    sessionId,
  );
}
