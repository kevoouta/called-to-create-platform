(() => {
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  const categoryKey = (value) => String(value || 'Course')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const getCourseSlug = (course) => course.slug || course.id;

  function formatPrice(course) {
    const price = course.price_kes ?? course.priceKES ?? course.price;
    if (price === null || price === undefined || price === '') return 'Price on request';
    return `KES ${Number(price).toLocaleString('en-KE')}`;
  }

  function getImageUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, window.location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  function renderCard(course, index, featuredLayout) {
    const category = course.category || 'Course';
    const safeCategory = escapeHtml(category);
    const key = escapeHtml(categoryKey(category));
    const slug = escapeHtml(encodeURIComponent(getCourseSlug(course) || ''));
    const title = escapeHtml(course.title || 'Untitled course');
    const description = escapeHtml(course.description || 'Course details coming soon.');
    const duration = escapeHtml(course.duration || '');
    const moduleCount = Number(course.module_count ?? course.modules_count ?? 0);
    const highlight = escapeHtml(course.card_highlight || course.highlight || 'Lifetime access included');
    const imageUrl = getImageUrl(course.image_url || course.thumbnail_url);
    const number = String(index + 1).padStart(2, '0');
    const image = imageUrl
      ? `<img src="${escapeHtml(imageUrl)}" alt="" class="absolute inset-0 w-full h-full object-cover" loading="lazy">`
      : `<span class="text-5xl font-heading text-gray-600 group-hover:text-brand-frost transition-colors">${number}</span>`;

    if (featuredLayout) {
      return `
        <article class="bg-brand-gray border border-gray-800 rounded-2xl overflow-hidden flex flex-col justify-between hover:border-brand-frost/60 transition-all group">
          <div>
            <div class="aspect-video bg-black/40 relative flex items-center justify-center p-4 overflow-hidden">
              ${image}
              <span class="bg-brand-frost/20 text-brand-frost text-[10px] font-bold px-2.5 py-1 rounded border border-brand-frost/30 uppercase tracking-widest absolute top-3 left-3 font-sans">${safeCategory}</span>
            </div>
            <div class="p-6 space-y-3">
              <h3 class="text-xl font-heading text-brand-white group-hover:text-brand-frost transition-colors">${title}</h3>
              <p class="text-xs text-gray-400 leading-relaxed font-sans">${description}</p>
              <div class="text-xs text-gray-400 pt-2 flex items-center space-x-3 font-sans">
                ${moduleCount ? `<span>${moduleCount} Modules</span><span aria-hidden="true">•</span>` : ''}
                <span>${duration}</span>
              </div>
            </div>
          </div>
          <div class="p-6 pt-0 border-t border-gray-800 mt-4 flex items-center justify-between">
            <span class="text-lg font-heading text-brand-frost">${formatPrice(course)}</span>
            <a href="course.html?id=${slug}" class="bg-brand-forest hover:bg-brand-frost hover:text-brand-forest text-brand-white border border-gray-700 text-xs font-bold px-4 py-2 rounded-xl transition-all font-sans">Enroll Now</a>
          </div>
        </article>`;
    }

    return `
      <article class="course-card ${key} bg-brand-gray border border-gray-800 rounded-3xl overflow-hidden flex flex-col justify-between hover:border-brand-frost/60 transition-all group" data-category="${key}">
        <div>
          <div class="aspect-video bg-black/50 relative flex items-center justify-center p-4 border-b border-gray-800/80 overflow-hidden">
            ${image}
            <span class="bg-brand-frost/20 text-brand-frost text-[10px] font-bold px-3 py-1 rounded-full border border-brand-frost/30 uppercase tracking-widest absolute top-4 left-4 font-sans">${safeCategory}</span>
          </div>
          <div class="p-6 space-y-3">
            <h3 class="text-2xl font-heading text-brand-white group-hover:text-brand-frost transition-colors">${title}</h3>
            <p class="text-xs text-gray-400 leading-relaxed font-sans">${description}</p>
            <div class="pt-2 flex items-center justify-between text-[11px] text-gray-400 font-sans border-t border-gray-800/60">
              <span>${moduleCount ? `${moduleCount} Modules` : ''}${moduleCount && duration ? ' • ' : ''}${duration}</span>
              <span class="text-brand-frost font-semibold">${highlight}</span>
            </div>
          </div>
        </div>
        <div class="p-6 pt-4 mt-4 flex items-center justify-between border-t border-gray-800/80">
          <div><span class="text-[10px] text-gray-400 block font-sans uppercase">Lifetime Price</span><span class="text-xl font-heading text-brand-frost">${formatPrice(course)}</span></div>
          <a href="course.html?id=${slug}" class="bg-brand-forest hover:bg-brand-frost hover:text-brand-forest text-brand-white border border-gray-700 text-xs font-bold px-5 py-2.5 rounded-xl transition-all font-sans">Enroll Now</a>
        </div>
      </article>`;
  }

  function renderExploreFilters(courses) {
    const filters = document.getElementById('courseCategoryFilters');
    if (!filters) return;

    const categories = [...new Map(courses
      .filter((course) => course.category)
      .map((course) => [categoryKey(course.category), course.category])).entries()];
    filters.replaceChildren();

    const addFilter = (label, key) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `cat-${key}`;
      button.className = 'cat-pill bg-brand-gray text-gray-300 hover:text-brand-white px-5 py-2.5 rounded-full cursor-pointer transition-colors whitespace-nowrap border border-gray-800';
      button.textContent = label;
      button.addEventListener('click', () => window.filterCategory(key));
      filters.append(button);
    };

    addFilter('All Courses', 'all');
    categories.forEach(([key, label]) => addFilter(label, key));
  }

  async function loadCourseCards(grid, featuredLayout) {
    if (!grid || !window.supabaseClient) return;

    const { data, error } = await window.supabaseClient
      .from('courses')
      .select('*');

    if (error) {
      console.error('Could not load course cards:', error);
      return;
    }

    const published = (data || []).filter((course) => course.is_published !== false);
    const courses = (featuredLayout
      ? published.filter((course) => course.is_featured === true)
      : published)
      .sort((first, second) => (first.display_order ?? 0) - (second.display_order ?? 0));

    grid.innerHTML = courses.length
      ? courses.map((course, index) => renderCard(course, index, featuredLayout)).join('')
      : '<p class="col-span-full text-sm text-gray-400 font-sans">No courses are available right now.</p>';

    if (featuredLayout) {
      const count = document.getElementById('featuredCourseCount');
      if (count) count.textContent = `${courses.length} Courses`;
    } else {
      renderExploreFilters(courses);
      window.filterCategory('all');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const featuredGrid = document.getElementById('featuredCourseGrid');
    const exploreGrid = document.getElementById('courseGrid');
    loadCourseCards(featuredGrid, true);
    loadCourseCards(exploreGrid, false);

    if (window.supabaseClient) {
      window.supabaseClient
        .channel('public-course-cards')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, () => {
          loadCourseCards(featuredGrid, true);
          loadCourseCards(exploreGrid, false);
        })
        .subscribe();
    }
  });
})();