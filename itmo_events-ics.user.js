// ==UserScript==
// @name         ITMO Events → ICS
// @namespace    vm-itmo-events-ics
// @version      0.0.1
// @author sabkvq
// @description  Добавляет кнопку скачивания .ics на страницах ITMO Events
// @match        https://itmo.events/*
// @grant        none
// @updateURL https://raw.githubusercontent.com/sabkvq/itmo.events-ics-userscript/refs/heads/main/itmo_events-ics.user.js
// @downloadURL https://raw.githubusercontent.com/sabkvq/itmo.events-ics-userscript/refs/heads/main/itmo_events-ics.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULT_DURATION_MINUTES = 120;
    const TIMEZONE = 'Europe/Moscow';

    const MONTHS = {
        'января': 0,
        'февраля': 1,
        'марта': 2,
        'апреля': 3,
        'мая': 4,
        'июня': 5,
        'июля': 6,
        'августа': 7,
        'сентября': 8,
        'октября': 9,
        'ноября': 10,
        'декабря': 11,
    };

    function pad(n) {
        return String(n).padStart(2, '0');
    }

    function escapeICS(value = '') {
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/\n/g, '\\n')
            .replace(/,/g, '\\,')
            .replace(/;/g, '\\;');
    }

    function foldICSLine(line) {
        const limit = 70;
        const result = [];

        while (line.length > limit) {
            result.push(line.slice(0, limit));
            line = ' ' + line.slice(limit);
        }

        result.push(line);
        return result.join('\r\n');
    }

    function parseRussianDate(text) {
        const match = text.match(
            /(\d{1,2})\s+([а-яё]+)\s*,?\s*(\d{1,2}):(\d{2})/i
        );

        if (!match) {
            throw new Error(`Не удалось разобрать дату: ${text}`);
        }

        const day = Number(match[1]);
        const monthName = match[2].toLowerCase();
        const hour = Number(match[3]);
        const minute = Number(match[4]);

        const month = MONTHS[monthName];

        if (month === undefined) {
            throw new Error(`Неизвестный месяц: ${monthName}`);
        }

        const now = new Date();
        let year = now.getFullYear();

        const candidate = new Date(
            year,
            month,
            day,
            hour,
            minute
        );

        // Если дата уже прошла — считаем, что это следующий год.
        if (
            candidate.getTime() <
            now.getTime() - 24 * 60 * 60 * 1000
        ) {
            year++;
        }

        return {
            year,
            month: month + 1,
            day,
            hour,
            minute,
        };
    }

    function addMinutes(parts, minutes) {
        const date = new Date(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute
        );

        date.setMinutes(date.getMinutes() + minutes);

        return {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hour: date.getHours(),
            minute: date.getMinutes(),
        };
    }

    function formatLocalICS(parts) {
        return (
            `${parts.year}` +
            `${pad(parts.month)}` +
            `${pad(parts.day)}` +
            `T${pad(parts.hour)}` +
            `${pad(parts.minute)}` +
            `00`
        );
    }

    function utcTimestamp() {
        const date = new Date();

        return (
            date.getUTCFullYear() +
            pad(date.getUTCMonth() + 1) +
            pad(date.getUTCDate()) +
            'T' +
            pad(date.getUTCHours()) +
            pad(date.getUTCMinutes()) +
            pad(date.getUTCSeconds()) +
            'Z'
        );
    }

    function makeUID() {
        return (
            Date.now().toString(36) +
            '-' +
            Math.random().toString(36).slice(2) +
            '@itmo.events'
        );
    }

    /**
     * Ищем секцию:
     *
     * Место проведения
     * [карта]
     * Кронверкский пр., д.49
     * Портал в Яндекс
     *
     * Возвращаем:
     * "Портал в Яндекс, Кронверкский пр., д.49"
     */
    function getLocation() {
        const sections = [...document.querySelectorAll('section')];

        const placeSection = sections.find(section => {
            const heading = section.querySelector('h1, h2, h3, h4');

            return heading?.textContent
                .trim()
                .toLowerCase() === 'место проведения';
        });

        if (!placeSection) {
            console.warn(
                '[ITMO Events → ICS] Секция "Место проведения" не найдена'
            );

            return '';
        }

        /*
         * Нам не хочется брать текст из самой Яндекс-карты:
         * "© Яндекс", "Открыть Яндекс Карты" и т.п.
         *
         * Поэтому ищем обычный flex-блок со span,
         * который находится рядом/после карты.
         */
        const candidates = [
            ...placeSection.querySelectorAll('div.flex.flex-col.gap-2')
        ];

        for (const block of candidates) {
            const spans = [...block.querySelectorAll(':scope > span')]
                .map(span => span.textContent.trim())
                .filter(Boolean);

            if (spans.length >= 1) {
                const address = spans[0] || '';
                const venue = spans[1] || '';

                if (venue && address) {
                    return `${venue}, ${address}`;
                }

                return venue || address;
            }
        }

        /*
         * Fallback на случай, если классы сайта поменяются.
         *
         * Берём span'ы вне карты и отбрасываем служебный текст.
         */
        const spans = [...placeSection.querySelectorAll('span')]
            .filter(span => !span.closest('.__ymap'))
            .map(span => span.textContent.trim())
            .filter(Boolean);

        if (spans.length >= 2) {
            const address = spans[0];
            const venue = spans[1];

            return `${venue}, ${address}`;
        }

        return spans[0] || '';
    }

    function getEventData() {
        const titleEl = document.querySelector('.hero__title');
        const infoEl = document.querySelector('.hero__extra-info');

        if (!titleEl || !infoEl) {
            return null;
        }

        const spans = [...infoEl.querySelectorAll('span')]
            .map(el => el.textContent.trim())
            .filter(Boolean);

        const dateText = spans.find(text =>
            /\d{1,2}\s+[а-яё]+\s*,?\s*\d{1,2}:\d{2}/i.test(text)
        );

        if (!dateText) {
            throw new Error('Дата мероприятия не найдена');
        }

        const start = parseRussianDate(dateText);
        const end = addMinutes(
            start,
            DEFAULT_DURATION_MINUTES
        );

        return {
            title: titleEl.textContent.trim(),

            // Теперь место берётся НЕ из hero,
            // а из секции "Место проведения".
            location: getLocation(),

            start,
            end,
            url: window.location.href,
        };
    }

    function buildICS(event) {
        const description =
            `Страница мероприятия: ${event.url}`;

        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//ITMO Events//Event to ICS//RU',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',

            'BEGIN:VEVENT',
            `UID:${makeUID()}`,
            `DTSTAMP:${utcTimestamp()}`,

            `DTSTART;TZID=${TIMEZONE}:${formatLocalICS(event.start)}`,
            `DTEND;TZID=${TIMEZONE}:${formatLocalICS(event.end)}`,

            `SUMMARY:${escapeICS(event.title)}`,
            `LOCATION:${escapeICS(event.location)}`,
            `DESCRIPTION:${escapeICS(description)}`,
            `URL:${escapeICS(event.url)}`,

            'END:VEVENT',
            'END:VCALENDAR',
        ];

        return lines
            .map(foldICSLine)
            .join('\r\n');
    }

    function safeFilename(name) {
        return (
            name
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 100) || 'event'
        );
    }

    function downloadICS() {
        try {
            const event = getEventData();

            if (!event) {
                throw new Error(
                    'Информация о мероприятии не найдена'
                );
            }

            console.log(
                '[ITMO Events → ICS] Event:',
                event
            );

            const ics = buildICS(event);

            const blob = new Blob(
                ['\uFEFF', ics],
                {
                    type: 'text/calendar;charset=utf-8',
                }
            );

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');

            a.href = url;
            a.download =
                `${safeFilename(event.title)}.ics`;

            document.body.appendChild(a);
            a.click();
            a.remove();

            setTimeout(
                () => URL.revokeObjectURL(url),
                1000
            );

        } catch (error) {
            console.error(
                '[ITMO Events → ICS]',
                error
            );

            alert(
                `Не удалось создать .ics:\n${error.message}`
            );
        }
    }

    function createButton() {
        if (
            document.querySelector(
                '#vm-download-ics'
            )
        ) {
            return;
        }

        const titleEl =
            document.querySelector('.hero__title');

        const infoEl =
            document.querySelector('.hero__extra-info');

        if (!titleEl || !infoEl) {
            return;
        }

        const hero =
            titleEl.closest('.max-w-\\[992px\\]') ||
            titleEl.parentElement;

        const buttons =
            hero?.querySelectorAll('button');

        let container = null;

        if (buttons?.length) {
            container =
                buttons[0].parentElement;
        }

        if (!container) {
            container =
                infoEl.parentElement;
        }

        const button =
            document.createElement('button');

        button.id =
            'vm-download-ics';

        button.type =
            'button';

        button.textContent =
            '📅 Скачать .ics';

        button.style.cssText = `
            height: 48px;
            padding: 0 22px;
            border: 0;
            border-radius: 9999px;
            background: #ffffff;
            color: #111111;
            font: inherit;
            font-size: 14px;
            cursor: pointer;
            box-shadow: 0 1px 3px rgba(0,0,0,.15);
            white-space: nowrap;
        `;

        button.addEventListener(
            'mouseenter',
            () => {
                button.style.background =
                    '#f3f4f6';
            }
        );

        button.addEventListener(
            'mouseleave',
            () => {
                button.style.background =
                    '#ffffff';
            }
        );

        button.addEventListener(
            'click',
            downloadICS
        );

        container.appendChild(button);
    }

    // itmo.events — SPA, поэтому содержимое может
    // появляться/меняться без полной перезагрузки страницы.
    createButton();

    const observer =
        new MutationObserver(() => {
            createButton();
        });

    observer.observe(
        document.documentElement,
        {
            childList: true,
            subtree: true,
        }
    );

})();
