document.addEventListener('DOMContentLoaded', async () => {
  const { jsonOptions, requestJson, setBusy, showNotice } = window.CalvingLog;
  const form = document.getElementById('medicine-form');
  const submit = document.getElementById('medicine-submit');
  const params = new URLSearchParams(window.location.search);
  const drugId = params.get('id');
  let currentUser = null;

  const field = id => document.getElementById(id);
  const textOrNull = id => field(id).value.trim() || null;
  const numberOrNull = id => field(id).value === '' ? null : Number(field(id).value);

  function updateRuleFields() {
    const fromCalving = field('calculation_basis').value === 'calving_date';
    field('minimum_dry_period_days').disabled = !fromCalving;
    if (!fromCalving) field('minimum_dry_period_days').value = '';
    field('regimen-notice').hidden = !field('requires_regimen').checked;
  }

  function fillForm(drug) {
    for (const name of [
      'drug_name', 'active_ingredient', 'acvm_registration_no', 'label_revision',
      'milk_withdrawal_value', 'milk_withdrawal_unit', 'meat_withdrawal_days',
      'calculation_basis', 'minimum_dry_period_days', 'label_wording',
      'source_reference', 'verified_on', 'verified_by'
    ]) {
      field(name).value = drug[name] ?? '';
    }
    field('whp_depends_on_dose').checked = Boolean(drug.whp_depends_on_dose);
    field('requires_regimen').checked = Boolean(drug.requires_regimen);
    field('is_active').checked = Boolean(drug.is_active);
    document.getElementById('editor-title').textContent = `Edit ${drug.drug_name}`;
    document.title = `Edit ${drug.drug_name} · Calving Log`;
    updateRuleFields();
  }

  function payload() {
    return {
      drug_name: textOrNull('drug_name'),
      active_ingredient: textOrNull('active_ingredient'),
      acvm_registration_no: textOrNull('acvm_registration_no'),
      label_revision: textOrNull('label_revision'),
      milk_withdrawal_value: numberOrNull('milk_withdrawal_value'),
      milk_withdrawal_unit: field('milk_withdrawal_unit').value,
      meat_withdrawal_days: numberOrNull('meat_withdrawal_days'),
      calculation_basis: field('calculation_basis').value,
      minimum_dry_period_days: numberOrNull('minimum_dry_period_days'),
      whp_depends_on_dose: field('whp_depends_on_dose').checked,
      requires_regimen: field('requires_regimen').checked,
      label_wording: textOrNull('label_wording'),
      source_reference: textOrNull('source_reference'),
      verified_on: textOrNull('verified_on'),
      verified_by: textOrNull('verified_by'),
      is_active: field('is_active').checked
    };
  }

  try {
    currentUser = await requestJson('/api/auth/me');
    if (!['owner', 'vet'].includes(currentUser.role)) {
      form.hidden = true;
      showNotice('#medicine-notice', 'Owner or Vet access is required to add or edit medicine references.', 'error');
      return;
    }
    if (!drugId) field('verified_by').value = currentUser.name;
    if (drugId) {
      const data = await requestJson('/api/drugs/reference-status');
      const drug = data.drugs.find(item => String(item.id) === String(drugId));
      if (!drug) throw new Error('Medicine not found');
      fillForm(drug);
    }
  } catch (error) {
    form.hidden = true;
    showNotice('#medicine-notice', error.message, 'error');
    return;
  }

  field('calculation_basis').addEventListener('change', updateRuleFields);
  field('requires_regimen').addEventListener('change', updateRuleFields);
  updateRuleFields();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(submit, true, 'Saving…');
    showNotice('#medicine-notice', '');
    try {
      const method = drugId ? 'PUT' : 'POST';
      const url = drugId ? `/api/drugs/${encodeURIComponent(drugId)}` : '/api/drugs';
      const saved = await requestJson(url, jsonOptions(method, payload()));
      const status = saved.is_active ? 'active and available for treatment entry' : 'saved as an inactive draft';
      showNotice('#medicine-notice', `${saved.drug_name} was ${status}.`, 'success');
      window.setTimeout(() => { window.location.href = '/medicines.html'; }, 900);
    } catch (error) {
      showNotice('#medicine-notice', error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  });
});
