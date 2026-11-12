(() => {
  const storagePrefix = 'c2c-cart:';
  const mount = document.getElementById('sharedCartMount');
  let currentUser = null;
  let drawer;
  let button;
  let countBadge;
  let itemsContainer;
  let status;
  let renderRequest = 0;

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

  function closeDrawer() {
    drawer?.classList.add('hidden');
  }

  function makeCheckoutLink(label, href) {
    const link = document.createElement('a');
    link.href = href;
    link.className = 'block w-full text-center bg-brand-frost text-brand-forest font-bold py-3 rounded-xl text-xs hover:bg-opacity-90 transition-all';
    link.textContent = label;
    return link;
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
    for (const id of cart.products) {
      const product = productResult.data.find((item) => String(item.id) === id);
      if (product) addCartItem(product, 'product');
    }

    if (cart.products.length > 0) {
      itemsContainer.append(makeCheckoutLink(
        'Checkout products',
        'shop.html?open_cart=1'
      ));
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
      </section>
    `;
    drawer.querySelector('section').addEventListener('click', (event) => event.stopPropagation());
    drawer.querySelector('.close-cart').addEventListener('click', closeDrawer);
    drawer.querySelector('.absolute.inset-0').addEventListener('click', closeDrawer);
    itemsContainer = drawer.querySelector('.cart-items');
    status = drawer.querySelector('.cart-status');
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
    });
    window.supabaseClient.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.error('Could not read session for cart control:', error);
        return;
      }
      setUser(data.session?.user || null);
    }).catch((error) => {
      console.error('Could not read session for cart control:', error);
    });
  }
})();
