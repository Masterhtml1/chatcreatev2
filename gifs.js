/* ==========================================================================
   GIF picker (GIPHY)

   PASTE YOUR KEY BELOW. Get a free one at https://developers.giphy.com/ —
   "Create an App" → choose the API (not SDK) option. Until a key is set the
   picker still opens and explains what is missing.

   The key is visible to anyone who views source. That is normal for GIPHY's
   browser keys — it only permits GIF search, and rate limits are per key, so
   the worst case is someone else burning your quota. Rotate it in the GIPHY
   dashboard if that happens.
   ========================================================================== */

const GIPHY_API_KEY = '';

/* 'g' = G only, 'pg' = G and PG, 'pg-13', 'r'. Set to G and PG. */
const GIPHY_RATING = 'pg';

const GIF_RESULT_LIMIT = 24;

let gifSearchTimer = null;
let gifRequestToken = 0;

function gifPickerElements() {
    return {
        picker: document.getElementById('gifPicker'),
        grid: document.getElementById('gifGrid'),
        search: document.getElementById('gifSearch')
    };
}

function toggleGifPicker() {
    const { picker } = gifPickerElements();
    if (!picker) return;

    if (picker.classList.contains('show')) {
        closeGifPicker();
        return;
    }

    picker.classList.add('show');
    const { search } = gifPickerElements();
    search.value = '';
    search.focus();
    loadGifs('');
}

function closeGifPicker() {
    const { picker } = gifPickerElements();
    if (picker) {
        picker.classList.remove('show');
    }
}

/* Typing searches; an empty box shows what is trending. */
function onGifSearchInput(value) {
    clearTimeout(gifSearchTimer);
    gifSearchTimer = setTimeout(() => loadGifs(value.trim()), 350);
}

async function loadGifs(query) {
    const { grid } = gifPickerElements();
    if (!grid) return;

    if (!GIPHY_API_KEY) {
        grid.innerHTML = `
            <div class="gif-message">
                <strong>No GIPHY API key set.</strong><br>
                Get a free key at developers.giphy.com, then paste it into
                <code>GIPHY_API_KEY</code> at the top of <code>gifs.js</code>.
            </div>`;
        return;
    }

    const token = ++gifRequestToken;
    grid.innerHTML = '<div class="gif-message">Loading GIFs…</div>';

    const endpoint = query
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=${GIF_RESULT_LIMIT}&rating=${GIPHY_RATING}&bundle=messaging_non_clips`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=${GIF_RESULT_LIMIT}&rating=${GIPHY_RATING}&bundle=messaging_non_clips`;

    try {
        const response = await fetch(endpoint);
        if (!response.ok) {
            throw new Error('GIPHY responded ' + response.status);
        }
        const payload = await response.json();

        // A slower earlier search must not overwrite a newer one
        if (token !== gifRequestToken) return;

        renderGifResults(payload.data || []);
    } catch (error) {
        if (token !== gifRequestToken) return;
        console.error('GIF search failed:', error);
        grid.innerHTML = '<div class="gif-message">Could not reach GIPHY. Check the API key and your connection.</div>';
    }
}

function renderGifResults(items) {
    const { grid } = gifPickerElements();
    if (!grid) return;

    if (!items.length) {
        grid.innerHTML = '<div class="gif-message">No GIFs found.</div>';
        return;
    }

    grid.innerHTML = items.map((item) => {
        const thumb = (item.images.fixed_width_downsampled || item.images.fixed_width || {}).url;
        const chosen = item.images.downsized_medium || item.images.original || {};
        if (!thumb || !chosen.url) return '';

        const title = (item.title || 'GIF').replace(/"/g, '&quot;').replace(/'/g, '');
        // Carry the dimensions so the message can reserve space before decode
        const width = parseInt(chosen.width, 10) || 0;
        const height = parseInt(chosen.height, 10) || 0;
        return `
            <button type="button" class="gif-item" title="${title}"
                    onclick="sendGif('${chosen.url}', '${title}', ${width}, ${height})">
                <img src="${thumb}" alt="${title}" loading="lazy">
            </button>`;
    }).join('');
}

/* Sends the chosen GIF as a message. Mirrors sendMessage()'s guards and
   message shape — `text` stays present but empty because the database rules
   require it, and the renderer skips an empty text line. */
function sendGif(url, title, width, height) {
    if (!currentUser || !currentChannel) return;

    if (bannedUsers.includes(currentUser.nickname)) {
        alert('You have been banned from sending messages.');
        return;
    }

    let displayNickname = currentUser.nickname;
    if (currentUser.isAdmin) {
        displayNickname = 'Admin';
    } else if (currentUser.isMod) {
        displayNickname = 'MOD';
    }

    const message = {
        author: currentUser.email,
        nickname: displayNickname,
        text: '',
        gifUrl: url,
        gifTitle: title || 'GIF',
        timestamp: Date.now(),
        isAdmin: currentUser.isAdmin,
        isMod: currentUser.isMod,
        senderId: currentUser.uid
    };

    if (width && height) {
        message.gifWidth = width;
        message.gifHeight = height;
    }

    if (typeof replyingTo !== 'undefined' && replyingTo) {
        message.replyTo = replyingTo.id;
    }

    const channelRef = database.ref('channels/' + currentChannel.substring(1) + '/messages');
    channelRef.push(message).then(() => {
        enforceMessageLimit(currentChannel.substring(1));
        cancelReply();
    });

    closeGifPicker();
}

/* Messages store the GIF's dimensions so the renderer can reserve the right
   height before it decodes, which means nothing shifts. This is only a safety
   net for GIFs sent before that (no stored size).

   By the time `load` fires the image has already grown, so "am I near the
   bottom?" would say no. Instead: if the whole gap is explained by this
   image's own height, the reader was at the bottom before it appeared. */
function onGifLoaded(img) {
    const container = document.getElementById('messagesContainer');
    if (!container || !img) return;

    const grewBy = img.getBoundingClientRect().height;
    const gap = container.scrollHeight - container.scrollTop - container.clientHeight;

    if (gap <= grewBy + SCROLL_STICK_THRESHOLD) {
        scrollToBottom(container);
    }
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeGifPicker();
    }
});

document.addEventListener('click', (event) => {
    const { picker } = gifPickerElements();
    if (!picker || !picker.classList.contains('show')) return;
    if (!picker.contains(event.target) && !event.target.closest('#gifButton')) {
        closeGifPicker();
    }
});
