const { syncReferencePackage } = require('./acvmAdditionalReferenceData');
const source = id => 'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=' + id;
const PRODUCTS = [
  {
    drug_name: 'Orbenin Dry Cow', active_ingredient: 'Cloxacillin (as benzathine salt)',
    milk_withdrawal_value: 8, milk_withdrawal_unit: 'milkings', meat_withdrawal_days: 28,
    calculation_basis: 'calving_date', minimum_dry_period_days: 30,
    whp_depends_on_dose: 0, requires_regimen: 0, acvm_registration_no: 'A000888',
    label_revision: 'A000888-23 - Approved Label - Mar 2026', source_reference: source(71344),
    label_wording: 'MILK: Milk for human consumption must not be taken from the first 8 milkings after calving. If calving occurs before 30 days after the last treatment, milk to be sold for human consumption may only be taken after the full 30 days from treatment and a further 8 milkings have elapsed. MEAT: Cows producing meat or offal for human consumption must not be sold for slaughter either during treatment or within 28 days of cessation of the last treatment.',
    rules: []
  },
  {
    drug_name: 'Orbenin Enduro', active_ingredient: 'Cloxacillin (as benzathine salt)',
    milk_withdrawal_value: 8, milk_withdrawal_unit: 'milkings', meat_withdrawal_days: 28,
    calculation_basis: 'calving_date', minimum_dry_period_days: 35,
    whp_depends_on_dose: 0, requires_regimen: 0, acvm_registration_no: 'A006036',
    label_revision: 'A006036-25 - Approved Label - Sept 2026', source_reference: source(72781),
    label_wording: 'MILK: Milk for human consumption must not be taken from the first 8 milkings after calving. If calving occurs before 35 days after the last treatment, milk to be sold for human consumption may only be taken after the full 35 days from treatment and a further 8 milkings have elapsed. MEAT: Animals producing meat and offal for human consumption must not be sold for slaughter during treatment or within 28 days of cessation of the last treatment.',
    rules: []
  },
  {
    drug_name: 'Penclox 1200', active_ingredient: 'Penicillin G procaine / cloxacillin sodium',
    milk_withdrawal_value: 9, milk_withdrawal_unit: 'milkings', meat_withdrawal_days: 10,
    calculation_basis: 'treatment_date', minimum_dry_period_days: null,
    whp_depends_on_dose: 0, requires_regimen: 1, acvm_registration_no: 'A010884',
    label_revision: 'A010884-13 - Approved Label - Dec 2024', source_reference: source(67246),
    label_wording: 'Milk: Twice-a-day milking - For 3, 4, 5 or 6 treatments given 24 hours apart: Milk intended for sale for human consumption must be discarded during treatment and for not less than 108 hours (9 milkings) following the last treatment. Milk: Once-a-day milking - For 3, 4, 5 or 6 treatments given 24 hours apart: Milk intended for sale for human consumption must be discarded during treatment and for not less than 120 hours (5 once-a-day milkings) following the last treatment. Meat: Animals producing meat or offal for human consumption must not be sold for slaughter either during or within 10 days of cessation of the last treatment.',
    rules: [{ rule_code: 'three_to_six_24_hourly', rule_name: '3 to 6 treatments at 24-hour intervals', description: 'Label course: 5 OAD milkings (120 hours) or 9 TAD milkings (108 hours) after the last treatment.', milkings_once_daily: 5, milkings_twice_daily: 9, is_default: 1 }]
  }
];
const VERSION = 'mpi-acvm-additions-2026-10-04';
function syncOctoberReferenceData(db) {
  return syncReferencePackage(db, { products: PRODUCTS, version: VERSION, verifiedOn: '2026-10-04', sourceSummary: 'Current MPI ACVM Approved Labels A000888-23, A006036-25, A010884-13; reviewed 2026-10-04. Intracillin not activated because combination therapy changes withholding.' });
}
module.exports = { syncOctoberReferenceData, PRODUCTS, VERSION };
