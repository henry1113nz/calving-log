function addDays(dateString, days) {
  const date = new Date(dateString);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

function calculateWithdrawalEndDate(event) {
  if (event.milk_withdrawal_days == null) {
    return null;
  }

  const baseDate = event.calculation_basis === 'calving_date'
    ? event.calving_date
    : event.event_date;

  if (!baseDate) {
    return null;
  }

  return addDays(baseDate, event.milk_withdrawal_days);
}

module.exports = { calculateWithdrawalEndDate };