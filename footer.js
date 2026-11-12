async function handleFooterSubscribe(event) {
  event.preventDefault();
  const btn = document.getElementById('footerSubmitBtn');
  const firstNameInput = document.getElementById('footerFirstNameInput');
  const emailInput = document.getElementById('footerEmailInput');
  const firstName = firstNameInput.value.trim();
  const email = emailInput.value.trim();

  if (!email) return;

  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const { error } = await window.supabaseClient
      .from('newsletter_subscribers')
      .insert([{ email, first_name: firstName || null }]);

    if (error) {
      if (error.code === '23505') {
        btn.textContent = 'Already Subscribed!';
        btn.classList.remove('bg-brand-frost', 'text-brand-forest');
        btn.classList.add('bg-emerald-600', 'text-white', 'cursor-default');
        firstNameInput.value = '';
        firstNameInput.disabled = true;
        emailInput.value = '';
        emailInput.placeholder = 'You are on the list!';
        emailInput.disabled = true;
      } else {
        console.error('Newsletter error:', error);
        btn.textContent = 'Try Again';
        btn.disabled = false;
      }
    } else {
      btn.textContent = 'Subscribed!';
      btn.classList.remove('bg-brand-frost', 'text-brand-forest', 'hover:bg-opacity-90');
      btn.classList.add('bg-emerald-600', 'text-white', 'cursor-default');
      firstNameInput.value = '';
      firstNameInput.disabled = true;
      emailInput.value = '';
      emailInput.placeholder = 'Thank you for joining us!';
      emailInput.disabled = true;
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    btn.textContent = 'Try Again';
    btn.disabled = false;
  }
}
