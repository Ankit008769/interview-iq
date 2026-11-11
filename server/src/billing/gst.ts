// GST for invoices (roadmap D5: "campus invoicing with GST"). Amounts are integers in paise.
// NEEDS REVIEW BY A CHARTERED ACCOUNTANT before the first real invoice: the SAC code, the rate, and the
// place-of-supply rules for unregistered consumers are configuration (GST_SAC, GST_RATE_PERCENT,
// GST_SUPPLIER_*), not legal advice.

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

// GSTIN: 2-digit state code, 10-character PAN, entity number, 'Z' by default, and a base-36 check character.
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinCheckChar(first14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}
export function validGstin(value: string) {
  const v = value.trim().toUpperCase();
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v) && v.slice(0, 2) in STATES && gstinCheckChar(v.slice(0, 14)) === v[14];
}

export type TaxLine = { description: string; sac: string; quantity: number; unitPrice: number; inclusive: boolean };
export type TaxedLine = TaxLine & { taxable: number; cgst: number; sgst: number; igst: number; total: number };
// Intra-state supplies carry CGST and SGST at half the rate each; inter-state supplies carry IGST.
export function taxLine(line: TaxLine, interState: boolean, ratePercent = 18): TaxedLine {
  if (!Number.isInteger(line.unitPrice) || line.unitPrice < 0 || !Number.isInteger(line.quantity) || line.quantity < 1) throw new Error('Invalid invoice line.');
  const gross = line.unitPrice * line.quantity;
  const taxable = line.inclusive ? Math.round(gross * 100 / (100 + ratePercent)) : gross;
  const tax = line.inclusive ? gross - taxable : Math.round(taxable * ratePercent / 100);
  const half = Math.floor(tax / 2);
  const [cgst, sgst, igst] = interState ? [0, 0, tax] : [half, tax - half, 0];
  return { ...line, taxable, cgst, sgst, igst, total: taxable + tax };
}

// Place of supply: the recipient's state for a registered business (from its GSTIN) or a known consumer
// address; otherwise the supplier's state.
export function placeOfSupply(supplierState: string, recipient: { gstin?: string; stateCode?: string }) {
  const code = recipient.gstin ? recipient.gstin.slice(0, 2) : recipient.stateCode && recipient.stateCode in STATES ? recipient.stateCode : supplierState;
  return { code, name: STATES[code] ?? code, interState: code !== supplierState };
}

// Indian financial year (April to March), e.g. 2026-27 → "2627".
export function financialYear(date: Date) {
  const ist = new Date(date.getTime() + 5.5 * 3_600_000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return { start, label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, short: `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}` };
}
// Invoice numbers are unique and consecutive per financial year and at most 16 characters (Rule 46).
export function invoiceNumber(prefix: string, date: Date, sequence: number) {
  const n = `${prefix}/${financialYear(date).short}/${String(sequence).padStart(6, '0')}`;
  if (!/^[A-Z0-9]{1,4}$/.test(prefix) || n.length > 16) throw new Error('Invoice number would be invalid.');
  return n;
}

export function supplier() {
  const s = { name: process.env.GST_SUPPLIER_NAME, address: process.env.GST_SUPPLIER_ADDRESS, gstin: process.env.GST_SUPPLIER_GSTIN?.toUpperCase(),
    prefix: process.env.GST_INVOICE_PREFIX ?? 'IQ', sac: process.env.GST_SAC ?? '999293', ratePercent: Number(process.env.GST_RATE_PERCENT ?? 18) };
  if (!s.name || !s.address || !s.gstin || !validGstin(s.gstin)) return null;
  return { ...s, name: s.name, address: s.address, gstin: s.gstin, stateCode: s.gstin.slice(0, 2) };
}
