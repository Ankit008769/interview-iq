// Disabled until a provider and verified sender are configured. Tests use an
// in-memory mailbox; production never logs links or returns tokens to the browser.
export function emailDeliveryAvailable() { return false; }
export async function sendAccountLink(_email: string, _purpose: 'reset' | 'verify', _url: string): Promise<void> {
  throw new Error('Account email delivery is not configured.');
}
