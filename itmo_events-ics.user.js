// ==UserScript==
// @name         ITMO Events → ICS
// @namespace    vm-itmo-events-ics
// @version      0.0.2
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

    function cleanText(text = '') {
        return String(text)
            .replace(/\u00A0/g, ' ')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function escapeICS(value = '') {
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/\r?\n/g, '\\n')
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

    function safeFilename(name) {
        return (
            name
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 100) || 'event'
        );
    }

    function findSectionByHeading(title) {
        const normalizedTitle = title.trim().toLowerCase();

        const sections = [
            ...document.querySelectorAll('section')
        ];

        return sections.find(section => {
            const heading = section.querySelector(
                'h1, h2, h3, h4'
            );

            return (
                heading?.textContent
                    .trim()
                    .toLowerCase() === normalizedTitle
            );
        }) || null;
    }

    function parseRussianDate(text) {
        const match = text.match(
            /(\d{1,2})\s+([а-яё]+)\s*,?\s*(\d{1,2}):(\d{2})/i
        );

        if (!match) {
            throw new Error(
                `Не удалось разобрать дату: ${text}`
            );
        }

        const day = Number(match[1]);
        const monthName = match[2].toLowerCase();
        const hour = Number(match[3]);
        const minute = Number(match[4]);

        const month = MONTHS[monthName];

        if (month === undefined) {
            throw new Error(
                `Неизвестный месяц: ${monthName}`
            );
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
        const totalMinutes =
            parts.hour * 60 +
            parts.minute +
            minutes;

        const daysToAdd =
            Math.floor(
                totalMinutes / (24 * 60)
            );

        const minuteOfDay =
            (
                (totalMinutes % (24 * 60)) +
                (24 * 60)
            ) %
            (24 * 60);

        const hour =
            Math.floor(
                minuteOfDay / 60
            );

        const minute =
            minuteOfDay % 60;

        const date =
            new Date(
                Date.UTC(
                    parts.year,
                    parts.month - 1,
                    parts.day + daysToAdd
                )
            );

        return {
            year:
                date.getUTCFullYear(),

            month:
                date.getUTCMonth() + 1,

            day:
                date.getUTCDate(),

            hour,
            minute,
        };
    }

    function formatLocalICS(parts) {
        return (
            `${parts.year}` +
            `${pad(parts.month)}` +
            `${pad(parts.day)}` +
            'T' +
            `${pad(parts.hour)}` +
            `${pad(parts.minute)}` +
            '00'
        );
    }

    function getLocation() {
        const placeSection =
            findSectionByHeading(
                'Место проведения'
            );

        if (!placeSection) {
            console.warn(
                '[ITMO Calendar] Секция "Место проведения" не найдена'
            );

            return '';
        }

        const candidates = [
            ...placeSection.querySelectorAll(
                'div.flex.flex-col.gap-2'
            )
        ];

        for (const block of candidates) {
            const spans = [
                ...block.querySelectorAll(
                    ':scope > span'
                )
            ]
                .map(span =>
                    cleanText(
                        span.textContent
                    )
                )
                .filter(Boolean);

            if (!spans.length) {
                continue;
            }

            const address =
                spans[0] || '';

            const venue =
                spans[1] || '';

            if (venue && address) {
                return `${venue}, ${address}`;
            }

            return venue || address;
        }

        const spans = [
            ...placeSection.querySelectorAll(
                'span'
            )
        ]
            .filter(
                span =>
                    !span.closest('.__ymap')
            )
            .map(
                span =>
                    cleanText(
                        span.textContent
                    )
            )
            .filter(Boolean);

        if (spans.length >= 2) {
            return `${spans[1]}, ${spans[0]}`;
        }

        return spans[0] || '';
    }

    function getAboutText() {
        const aboutSection =
            findSectionByHeading(
                'О событии'
            );

        if (!aboutSection) {
            console.warn(
                '[ITMO Calendar] Секция "О событии" не найдена'
            );

            return '';
        }

        const descriptionEl =
            aboutSection.querySelector(
                '.description_full'
            );

        if (descriptionEl) {
            return cleanText(
                descriptionEl.innerText ||
                descriptionEl.textContent
            );
        }

        const clone =
            aboutSection.cloneNode(true);

        clone
            .querySelectorAll(
                'h1, h2, h3, h4, button'
            )
            .forEach(
                el => el.remove()
            );

        return cleanText(
            clone.innerText ||
            clone.textContent
        );
    }

    function getContacts() {
        const headings = [
            ...document.querySelectorAll(
                'h1, h2, h3, h4'
            )
        ];

        const contactHeading =
            headings.find(el =>
                cleanText(
                    el.textContent
                ).toLowerCase() ===
                'контактные лица'
            );

        if (!contactHeading) {
            return [];
        }

        const root =
            contactHeading.parentElement;

        if (!root) {
            return [];
        }

        const peopleContainer =
            root.querySelector(
                '.flex.flex-col.gap-6'
            );

        if (!peopleContainer) {
            return [];
        }

        const personBlocks = [
            ...peopleContainer.children
        ];

        const contacts = [];

        for (const person of personBlocks) {
            const nameEl =
                person.querySelector(
                    '.text-base.font-medium'
                );

            const roleEl =
                person.querySelector(
                    '.text-xs.font-normal.text-black-300'
                );

            const name =
                cleanText(
                    nameEl?.textContent || ''
                );

            const role =
                cleanText(
                    roleEl?.textContent || ''
                );

            const mailLinks = [
                ...person.querySelectorAll(
                    'a[href^="mailto:"]'
                )
            ];

            const emails =
                mailLinks
                    .map(a => {
                        const text =
                            cleanText(
                                a.textContent
                            );

                        if (text) {
                            return text;
                        }

                        return cleanText(
                            (
                                a.getAttribute(
                                    'href'
                                ) || ''
                            ).replace(
                                /^mailto:\s*/i,
                                ''
                            )
                        );
                    })
                    .filter(Boolean);

            if (
                !name &&
                !role &&
                !emails.length
            ) {
                continue;
            }

            contacts.push({
                name,
                role,
                emails,
            });
        }

        return contacts;
    }

    function formatContacts(contacts) {
        if (!contacts.length) {
            return '';
        }

        return contacts
            .map(contact => {
                let result = '';

                if (contact.name) {
                    result +=
                        contact.name;
                }

                if (contact.role) {
                    result +=
                        result
                            ? ` — ${contact.role}`
                            : contact.role;
                }

                if (contact.emails.length) {
                    result +=
                        `${result ? '\n' : ''}` +
                        contact.emails.join(', ');
                }

                return result;
            })
            .filter(Boolean)
            .join('\n\n');
    }

    function buildDescription(event) {
        const parts = [];

        if (event.about) {
            parts.push(
                event.about
            );
        }

        if (event.contacts.length) {
            parts.push(
                'Контактные лица:\n' +
                formatContacts(
                    event.contacts
                )
            );
        }

        parts.push(
            'Страница мероприятия:\n' +
            event.url
        );

        return parts.join(
            '\n\n'
        );
    }

    function getEventData() {
        const titleEl =
            document.querySelector(
                '.hero__title'
            );

        const infoEl =
            document.querySelector(
                '.hero__extra-info'
            );

        if (!titleEl || !infoEl) {
            return null;
        }

        const spans = [
            ...infoEl.querySelectorAll(
                'span'
            )
        ]
            .map(
                el =>
                    cleanText(
                        el.textContent
                    )
            )
            .filter(Boolean);

        const dateText =
            spans.find(text =>
                /\d{1,2}\s+[а-яё]+\s*,?\s*\d{1,2}:\d{2}/i
                    .test(text)
            );

        if (!dateText) {
            throw new Error(
                'Дата мероприятия не найдена'
            );
        }

        const start =
            parseRussianDate(
                dateText
            );

        const end =
            addMinutes(
                start,
                DEFAULT_DURATION_MINUTES
            );

        return {
            title:
                cleanText(
                    titleEl.textContent
                ),

            location:
                getLocation(),

            about:
                getAboutText(),

            contacts:
                getContacts(),

            start,
            end,

            url:
                window.location.href,
        };
    }

    function buildICS(event) {
        const description =
            buildDescription(
                event
            );

        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//ITMO Events//Calendar//RU',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',

            'BEGIN:VEVENT',

            `UID:${makeUID()}`,

            `DTSTAMP:${utcTimestamp()}`,

            `DTSTART;TZID=${TIMEZONE}:` +
                formatLocalICS(
                    event.start
                ),

            `DTEND;TZID=${TIMEZONE}:` +
                formatLocalICS(
                    event.end
                ),

            `SUMMARY:${escapeICS(
                event.title
            )}`,

            `LOCATION:${escapeICS(
                event.location
            )}`,

            `DESCRIPTION:${escapeICS(
                description
            )}`,

            `URL:${escapeICS(
                event.url
            )}`,

            'END:VEVENT',

            'END:VCALENDAR',
        ];

        return lines
            .map(
                foldICSLine
            )
            .join(
                '\r\n'
            );
    }

    function downloadICS() {
        try {
            const event =
                getEventData();

            if (!event) {
                throw new Error(
                    'Информация о мероприятии не найдена'
                );
            }

            const ics =
                buildICS(
                    event
                );

            const blob =
                new Blob(
                    [
                        '\uFEFF',
                        ics
                    ],
                    {
                        type:
                            'text/calendar;charset=utf-8',
                    }
                );

            const blobURL =
                URL.createObjectURL(
                    blob
                );

            const a =
                document.createElement(
                    'a'
                );

            a.href =
                blobURL;

            a.download =
                `${safeFilename(
                    event.title
                )}.ics`;

            document.body.appendChild(
                a
            );

            a.click();

            a.remove();

            setTimeout(
                () =>
                    URL.revokeObjectURL(
                        blobURL
                    ),
                1000
            );

        } catch (error) {
            console.error(
                '[ITMO Calendar] ICS:',
                error
            );

            alert(
                'Не удалось создать .ics:\n' +
                error.message
            );
        }
    }

    function openGoogleCalendar() {
        try {
            const event =
                getEventData();

            if (!event) {
                throw new Error(
                    'Информация о мероприятии не найдена'
                );
            }

            const description =
                buildDescription(
                    event
                );

            const start =
                formatLocalICS(
                    event.start
                );

            const end =
                formatLocalICS(
                    event.end
                );

            const params =
                new URLSearchParams({
                    action:
                        'TEMPLATE',

                    text:
                        event.title,

                    dates:
                        `${start}/${end}`,

                    ctz:
                        TIMEZONE,

                    location:
                        event.location,

                    details:
                        description,
                });

            const url =
                'https://calendar.google.com/calendar/render?' +
                params.toString();

            window.open(
                url,
                '_blank',
                'noopener,noreferrer'
            );

        } catch (error) {
            console.error(
                '[ITMO Calendar] Google:',
                error
            );

            alert(
                'Не удалось открыть Google Calendar:\n' +
                error.message
            );
        }
    }

    function applyButtonStyle(button) {
        button.style.cssText = `
            height: 48px;
            padding: 0 20px;

            border: 0;
            border-radius: 9999px;

            background: #ffffff;
            color: #111111;

            font: inherit;
            font-size: 14px;
            font-weight: 500;

            cursor: pointer;

            box-shadow:
                0 1px 3px rgba(0, 0, 0, .15);

            white-space: nowrap;

            transition:
                background-color .15s ease,
                transform .1s ease;
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

                button.style.transform =
                    '';
            }
        );

        button.addEventListener(
            'mousedown',
            () => {
                button.style.transform =
                    'scale(.97)';
            }
        );

        button.addEventListener(
            'mouseup',
            () => {
                button.style.transform =
                    '';
            }
        );
    }

    function makeButton(
        text,
        onClick
    ) {
        const button =
            document.createElement(
                'button'
            );

        button.type =
            'button';

        button.textContent =
            text;

        applyButtonStyle(
            button
        );

        button.addEventListener(
            'click',
            onClick
        );

        return button;
    }

    function createButtons() {
        if (
            document.querySelector(
                '#vm-calendar-buttons'
            )
        ) {
            return;
        }

        const titleEl =
            document.querySelector(
                '.hero__title'
            );

        const infoEl =
            document.querySelector(
                '.hero__extra-info'
            );

        if (!titleEl || !infoEl) {
            return;
        }

        const hero =
            titleEl.closest(
                '.max-w-\\[992px\\]'
            ) ||
            titleEl.parentElement;

        const existingButtons =
            hero?.querySelectorAll(
                'button'
            );

        let container = null;

        if (
            existingButtons?.length
        ) {
            container =
                existingButtons[0]
                    .parentElement;
        }

        if (!container) {
            container =
                infoEl.parentElement;
        }

        const wrapper =
            document.createElement(
                'div'
            );

        wrapper.id =
            'vm-calendar-buttons';

        wrapper.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        `;

        const googleButton =
            makeButton(
                '📅 Google',
                openGoogleCalendar
            );

        googleButton.id =
            'vm-google-calendar';

        wrapper.appendChild(
            googleButton
        );

        const icsButton =
            makeButton(
                '⬇️ .ics',
                downloadICS
            );

        icsButton.id =
            'vm-download-ics';

        wrapper.appendChild(
            icsButton
        );

        container.appendChild(
            wrapper
        );
    }

    let lastURL =
        window.location.href;

    function handlePageChange() {
        const currentURL =
            window.location.href;

        if (
            currentURL !== lastURL
        ) {
            lastURL =
                currentURL;
        }

        createButtons();
    }

    createButtons();

    const observer =
        new MutationObserver(
            () => {
                handlePageChange();
            }
        );

    observer.observe(
        document.documentElement,
        {
            childList: true,
            subtree: true,
        }
    );
})();
