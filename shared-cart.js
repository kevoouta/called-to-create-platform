(() => {
  const storagePrefix = 'c2c-cart:';
  const mount = document.getElementById('sharedCartMount');
  let currentUser = null;
  let drawer;
  let button;
  let countBadge;
  let itemsContainer;
  let status;
  let checkoutPanel;
  let total;
  let checkoutButton;
  let renderRequest = 0;
  let returnProcessing = false;

  function emptyCart() {
    return { courses: [], products: [] };
  }

  function storageKey(userId) {
    if (typeof userId !== 'string' || !userId) {
      throw new Error('A signed-in user is required to access the cart.');
    }
    return `${storagePrefix}${userId}`;
  }

  function readCart(userId) {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return emptyCart();

    let cart;
    try {
      cart = JSON.parse(raw);
    } catch (error) {
      console.error('Could not read the saved cart:', error);
      throw new Error('The saved cart could not be read. Clear it or contact support.');
    }

    if (
      !cart ||
      !Array.isArray(cart.courses) ||
      !Array.isArray(cart.products) ||
      [...cart.courses, ...cart.products].some((id) => typeof id !== 'string')
    ) {
      throw new Error('The saved cart has an invalid format.');
    }

    return {
      courses: [...new Set(cart.courses)],
      products: cart.products
    };
  }

  function writeCart(userId, cart) {
    localStorage.setItem(storageKey(userId), JSON.stringify({
      courses: [...new Set(cart.courses)],
      products: cart.products
    }));
    window.dispatchEvent(new CustomEvent('c2c-cart-updated', { detail: { userId } }));
  }

  function getCart(userId = currentUser?.id) {
    return userId ? readCart(userId) : emptyCart();
  }

  function setProducts(userId, productIds) {
    const cart = readCart(userId);
    cart.products = productIds.map(String);
    writeCart(userId, cart);
  }

  function addCourse(userId, courseId) {
    const cart = readCart(userId);
    cart.courses.push(String(courseId));
    writeCart(userId, cart);
  }

  function removeCourse(userId, courseId) {
    const cart = readCart(userId);
    cart.courses = cart.courses.filter((id) => id !== String(courseId));
    writeCart(userId, cart);
  }

  function removeProduct(userId, productId) {
    const cart = readCart(userId);
    const index = cart.products.indexOf(String(productId));
    if (index >= 0) cart.products.splice(index, 1);
    writeCart(userId, cart);
  }

  function makeButton(label, className, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
  }

  function makeCheckoutLink(label, href) {
    const link = document.createElement('a');
    link.href = href;
    link.className = 'block w-full text-center bg-brand-frost text-brand-forest font-bold py-3 rounded-xl text-xs hover:bg-opacity-90 transition-all';
    link.textContent = label;
    return link;
  }

  function closeDrawer() {
    drawer?.classList.add('hidden');
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.remove('hidden', 'text-red-400', 'text-brand-frost');
    status.classList.add(isError ? 'text-red-400' : 'text-brand-frost');
  }

  function setCheckoutButton(disabled, label = 'Continue to Paystack') {
    checkoutButton.disabled = disabled;
    checkoutButton.textContent = label;
  }

  function pendingProductsKey(userId) {
    return `c2c-cart-checkout:${userId}`;
  }

  async function getCheckoutErrorMessage(error) {
    if (error?.context instanceof Response) {
      const body = await error.context.clone().text();
      if (body) {
        try {
          const payload = JSON.parse(body);
          if (typeof payload.error === 'string') return payload.error;
        } catch {
          return body;
        }
      }
    }
    return error?.message || 'Checkout could not be completed. Please try again.';
  }

  async function verifyProductPayment(reference, productIds, clearReturnUrl = false) {
    if (!reference) {
      showStatus('Paystack did not return a payment reference. Please contact support.', true);
      setCheckoutButton(false);
      return;
    }
    if (!currentUser) {
      showStatus('Log in to confirm your payment and complete your order.', true);
      return;
    }

    showStatus('Confirming your payment...');
    let result;
    try {
      result = await window.supabaseClient.functions.invoke('paystack-checkout', {
        body: { action: 'verify', reference }
      });
    } catch (error) {
      console.error('Could not verify digital asset payment:', error);
      showStatus(await getCheckoutErrorMessage(error), true);
      setCheckoutButton(false);
      return;
    }

    const { data, error } = result;
    if (error) {
      console.error('Could not verify digital asset payment:', error);
      showStatus(await getCheckoutErrorMessage(error), true);
      setCheckoutButton(false);
      return;
    }

    if (clearReturnUrl) {
      const params = new URLSearchParams(window.location.search);
      params.delete('c2c_cart_return');
      params.delete('reference');
      params.delete('trxref');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }

    if (data?.status === 'success' && data.kind === 'product') {
      if (productIds.length === 0) {
        showStatus('Payment confirmed, but the saved cart could not be matched. Check your Library before trying checkout again.', true);
        setCheckoutButton(true, 'Payment Confirmed');
        return;
      }
      const idsToRemove = new Set(productIds);
      try {
        const remainingProducts = getCart(currentUser.id).products.filter((id) => !idsToRemove.has(id));
        setProducts(currentUser.id, remainingProducts);
        sessionStorage.removeItem(pendingProductsKey(currentUser.id));
        window.dispatchEvent(new CustomEvent('c2c-product-purchase-completed', {
          detail: { userId: currentUser.id, productIds }
        }));
        await renderCart();
        showStatus('Payment confirmed. Your digital asset order has been recorded.');
      } catch (error) {
        console.error('Payment was confirmed, but the saved cart could not be updated:', error);
        showStatus('Payment confirmed, but your saved cart could not be updated. Check your Library before trying checkout again.', true);
        setCheckoutButton(true, 'Payment Confirmed');
      }
      return;
    }
    if (data?.status === 'refunded') {
      showStatus('This order was refunded. Your cart is ready for a new checkout.', true);
    } else {
      showStatus('Payment was not completed. Your cart is ready to try again.', true);
    }
    sessionStorage.removeItem(pendingProductsKey(currentUser.id));
    setCheckoutButton(false);
  }

  async function handleProductCheckout(productIds) {
    if (!currentUser) {
      showStatus('Log in to continue to checkout.', true);
      return;
    }
    if (!productIds.length) {
      showStatus('Your product cart is empty.', true);
      return;
    }

    setCheckoutButton(true, 'Opening Paystack...');
    showStatus('Preparing your secure checkout...');
    try {
      const callbackUrl = new URL(window.location.href);
      callbackUrl.searchParams.delete('reference');
      callbackUrl.searchParams.delete('trxref');
      callbackUrl.searchParams.set('c2c_cart_return', 'products');
      sessionStorage.setItem(pendingProductsKey(currentUser.id), JSON.stringify(productIds));

      const { data, error } = await window.supabaseClient.functions.invoke('paystack-checkout', {
        body: {
          action: 'initialize',
          kind: 'product',
          itemIds: productIds,
          callbackUrl: callbackUrl.toString()
        }
      });
      if (error) throw error;
      if (typeof data?.accessCode !== 'string' || !data.accessCode) {
        throw new Error('Paystack did not return a checkout access code.');
      }
      if (typeof PaystackPop !== 'function') {
        throw new Error('Paystack checkout could not load. Check your connection and try again.');
      }

      const popup = new PaystackPop();
      popup.resumeTransaction(data.accessCode, {
        onSuccess: (transaction) => {
          void verifyProductPayment(transaction?.reference || data.reference, productIds);
        },
        onCancel: () => {
          sessionStorage.removeItem(pendingProductsKey(currentUser.id));
          showStatus('Payment was cancelled. Your assets are still in the cart.', true);
          setCheckoutButton(false);
        },
        onError: (error) => {
          console.error('Paystack digital asset popup error:', error);
          showStatus(error?.message || 'Paystack checkout could not be opened.', true);
          setCheckoutButton(false);
        }
      });
    } catch (error) {
      console.error('Could not start digital asset checkout:', error);
      showStatus(await getCheckoutErrorMessage(error), true);
      setCheckoutButton(false);
    }
  }

  async function processProductPaymentReturn() {
    if (
      returnProcessing ||
      !currentUser ||
      new URLSearchParams(window.location.search).get('c2c_cart_return') !== 'products'
    ) return;
    returnProcessing = true;
    try {
      drawer.classList.remove('hidden');
      await renderCart();
      let ids = [];
      try {
        const savedIds = JSON.parse(sessionStorage.getItem(pendingProductsKey(currentUser.id)) || '[]');
        if (Array.isArray(savedIds)) ids = savedIds.filter((id) => typeof id === 'string');
      } catch (error) {
        console.error('Could not read the pending cart checkout:', error);
        showStatus('Could not restore the products for payment confirmation.', true);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      await verifyProductPayment(params.get('reference') || params.get('trxref'), ids, true);
    } finally {
      returnProcessing = false;
    }
  }

  function addCartItem(item, type) {
    const row = document.createElement('div');
    row.className = 'flex items-start justify-between gap-4 p-3 bg-brand-gray rounded-xl border border-gray-800';

    const details = document.createElement('div');
    details.className = 'min-w-0';
    const title = document.createElement('p');
    title.className = 'font-bold text-brand-white break-words';
    title.textContent = item.title || 'Untitled item';
    const price = document.createElement('p');
    price.className = 'text-brand-frost font-bold mt-1';
    price.textContent = type === 'course'
      ? `KES ${Number(item.price_kes || 0).toLocaleString('en-KE')}`
      : `KES ${Number(item.price || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    details.append(title, price);

    const removeButton = makeButton(
      'Remove',
      'text-xs text-gray-400 hover:text-brand-white shrink-0',
      () => {
        try {
          if (type === 'course') removeCourse(currentUser.id, item.id);
          else removeProduct(currentUser.id, item.id);
          void renderCart();
        } catch (error) {
          console.error('Could not update the cart:', error);
          status.textContent = error.message || 'Could not update the cart.';
          status.classList.remove('hidden');
        }
      }
    );

    row.append(details, removeButton);
    itemsContainer.append(row);

    if (type === 'course') {
      itemsContainer.append(makeCheckoutLink(
        'Checkout this course',
        `course.html?id=${encodeURIComponent(item.slug || item.id)}&open_cart=1`
      ));
    }
  }

  async function renderCart() {
    if (!drawer || !currentUser) return;
    const requestId = ++renderRequest;
    itemsContainer.replaceChildren();
    status.classList.add('hidden');
    checkoutPanel.classList.add('hidden');
    checkoutButton.classList.add('hidden');
    checkoutButton.disabled = false;
    checkoutButton.textContent = 'Continue to Paystack';

    let cart;
    try {
      cart = getCart(currentUser.id);
      countBadge.textContent = String(cart.courses.length + cart.products.length);
    } catch (error) {
      console.error('Could not read cart:', error);
      status.textContent = error.message || 'The cart could not be read.';
      status.classList.remove('hidden');
      return;
    }

    if (cart.courses.length === 0 && cart.products.length === 0) {
      const emptyMessage = document.createElement('p');
      emptyMessage.className = 'text-sm text-gray-400';
      emptyMessage.textContent = 'Your cart is empty.';
      itemsContainer.append(emptyMessage);
      return;
    }

    const client = window.supabaseClient;
    const [courseResult, productResult] = await Promise.all([
      cart.courses.length
        ? client.from('courses').select('id,slug,title,price_kes').in('id', cart.courses)
        : Promise.resolve({ data: [], error: null }),
      cart.products.length
        ? client.from('products').select('id,title,price').in('id', cart.products)
        : Promise.resolve({ data: [], error: null })
    ]);

    if (requestId !== renderRequest || !currentUser) return;
    if (courseResult.error || productResult.error) {
      const error = courseResult.error || productResult.error;
      console.error('Could not load cart items:', error);
      status.textContent = 'Cart items could not be loaded. Please try again.';
      status.classList.remove('hidden');
      return;
    }

    for (const id of cart.courses) {
      const course = courseResult.data.find((item) => String(item.id) === id);
      if (course) addCartItem(course, 'course');
    }
    const products = cart.products
      .map((id) => productResult.data.find((item) => String(item.id) === id))
      .filter(Boolean);
    for (const product of products) {
      addCartItem(product, 'product');
    }

    if (products.length > 0) {
      total.textContent = `KES ${products.reduce((sum, product) => sum + Number(product.price || 0), 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      checkoutPanel.classList.remove('hidden');
      checkoutButton.classList.remove('hidden');
      checkoutButton.disabled = false;
      checkoutButton.textContent = 'Continue to Paystack';
      checkoutButton.onclick = () => void handleProductCheckout(products.map((product) => String(product.id)));
    }
    if (itemsContainer.childElementCount === 0) {
      const emptyMessage = document.createElement('p');
      emptyMessage.className = 'text-sm text-gray-400';
      emptyMessage.textContent = 'These cart items are no longer available.';
      itemsContainer.append(emptyMessage);
    }
  }

  function setUser(user) {
    currentUser = user && typeof user.id === 'string' ? user : null;
    if (mount) mount.hidden = !currentUser;
    if (!countBadge) return;
    if (currentUser) {
      try {
        const cart = getCart(currentUser.id);
        countBadge.textContent = String(cart.courses.length + cart.products.length);
      } catch (error) {
        console.error('Could not read cart:', error);
        countBadge.textContent = '!';
      }
    } else {
      closeDrawer();
      countBadge.textContent = '0';
    }
  }

  function openDrawer() {
    if (!currentUser) return;
    drawer.classList.remove('hidden');
    void renderCart();
  }

  function mountCart() {
    if (!mount) return;

    button = makeButton(
      'Cart',
      'bg-brand-gray border border-gray-700 hover:border-brand-frost/50 text-brand-white px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all',
      openDrawer
    );
    button.setAttribute('aria-label', 'Open cart');
    countBadge = document.createElement('span');
    countBadge.className = 'bg-brand-frost text-brand-forest rounded-full min-w-5 px-1.5 py-0.5 text-center';
    countBadge.textContent = '0';
    button.append(countBadge);
    mount.append(button);
    mount.hidden = true;

    drawer = document.createElement('div');
    drawer.className = 'fixed inset-0 z-[60] hidden bg-black/80 backdrop-blur-sm flex justify-end';
    drawer.innerHTML = `
      <button type="button" class="absolute inset-0 cursor-default" aria-label="Close cart"></button>
      <section class="relative bg-brand-forest border-l border-gray-800 w-full max-w-md h-full p-6 md:p-8 flex flex-col gap-6" role="dialog" aria-modal="true" aria-labelledby="sharedCartTitle">
        <div class="flex items-center justify-between border-b border-gray-800 pb-4">
          <h2 id="sharedCartTitle" class="text-2xl font-heading text-brand-white">Your Cart</h2>
          <button type="button" class="close-cart text-gray-400 hover:text-brand-white text-lg font-bold" aria-label="Close cart">✕</button>
        </div>
        <p class="cart-status hidden text-xs text-red-400" role="status"></p>
        <div class="cart-items space-y-3 overflow-y-auto flex-1"></div>
        <div class="cart-checkout hidden border-t border-gray-800 pt-5 space-y-4">
          <div class="flex items-center justify-between text-sm">
            <span class="text-gray-400">Products total</span>
            <span class="cart-total text-brand-frost font-bold"></span>
          </div>
          <button type="button" class="checkout-products hidden w-full bg-brand-frost text-brand-forest font-bold py-3.5 rounded-xl text-xs hover:bg-opacity-90 transition-all disabled:opacity-60 disabled:cursor-wait">Continue to Paystack</button>
        </div>
      </section>
    `;
    drawer.querySelector('section').addEventListener('click', (event) => event.stopPropagation());
    drawer.querySelector('.close-cart').addEventListener('click', closeDrawer);
    drawer.querySelector('.absolute.inset-0').addEventListener('click', closeDrawer);
    itemsContainer = drawer.querySelector('.cart-items');
    status = drawer.querySelector('.cart-status');
    checkoutPanel = drawer.querySelector('.cart-checkout');
    total = drawer.querySelector('.cart-total');
    checkoutButton = drawer.querySelector('.checkout-products');
    document.body.append(drawer);

    window.addEventListener('c2c-cart-updated', (event) => {
      if (event.detail?.userId !== currentUser?.id) return;
      setUser(currentUser);
      if (!drawer.classList.contains('hidden')) void renderCart();
    });
    window.addEventListener('storage', (event) => {
      if (currentUser && event.key === storageKey(currentUser.id)) setUser(currentUser);
    });
  }

  window.C2CSharedCart = {
    addCourse,
    getCart,
    removeCourse,
    setProducts,
    setUser
  };

  if (mount) {
    mountCart();
    window.supabaseClient.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      if (session?.user) void processProductPaymentReturn();
    });
    window.supabaseClient.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.error('Could not read session for cart control:', error);
        return;
      }
      setUser(data.session?.user || null);
      if (data.session?.user) void processProductPaymentReturn();
    }).catch((error) => {
      console.error('Could not read session for cart control:', error);
    });
  }
})();
