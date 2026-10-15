<pre>
Fixed/changed in version 4.0.4:
-Added Most Visited tab
-Fixed and added few translations
-Fixed current date label bug
-Added new banner for Chrome Store

Fixed/changed in version 4.0.5:
-Added ability to search history in the popup
-Added recent tabs view in the popup
-Fixed light theme bugs and style
-Added popup settings in settings

Fixed/changed in version 4.0.6:
-Added Tab Storage to save tabs and restore them
-Changed two icons
-Sessions are now grouped by windows (export still needs fixing)

Fixed/changed in version 4.0.7: 
-Added reading mode (my idea)
-Added history encryption on export and decryption on import and for reading mode (my idea)
-Fixed date pills scrolling positions
-Fixed title storing getting when visiting pages
-Added option to see and store current tabs by right clicking tab storage in popup (my idea)
-Fixed multiple words search like "bread butter" will find everything that contains those two words (idea based on better history bad review)
-Added option to auto focus search input when history page opens (idea based on better history bad review)
-Added option to choose favicon resolver
-Added more translations
-Changed scrolling arrow positions and added option to hold buttons to scroll
-"All" button is always at the begining now at dates bar

Fixed/changed in version 4.0.8: 
-Architectural change for perfomance, 
  fast url chanigng doesn't trigger saving to local storage anymore, 
  instead todays history is shown via chrome api, 
  and merged every half hour into local history and on browser startup. 
  Interval can be increased in settings, if PC is used for longer hours.
-Bookmarks moving trickery to improve speed, having large folders makes moving bookmarks laggy,
  so hide panel, but show it as image drawn on canvas (my idea). Will lazy load in future.
-"Tab Storage" and "Recent History" now change text on right click,
  and "Recent History" on right click shows most visited sites in last 10 days.
-Restoring tabs from tab storage doesn't reset scroll position anymore
-Scroll positioning for date pills is fixed now and works even if browser width is lower,
  6 pills away on large width, 2 pills away on small width.
-Clicking "Store" while on extension page now warns that page can't be stored (idea based on feedback, to reduce confusion)
-Added option select and delete history inside popup, just for "Recent History" for now.
-Added option to turn of time tracking to reduce cpu usage (a little bit) if option not needed
-Fixed deleting, it didn't work well

Fixed/changed in version 4.0.9:
-Ignore lists now require password to be seen (easy password reset, just resets ignore list if you forgot password)
-Searched results in popup can now be deleten
-Stored tabs can be unstored now inside popup
-Fixed auto session export .html file to include windows grouping and tab storage now
-Bookmarks now show date added next to them
-Disabled time pills when using "All" filter
-Added keyword option in ignore lists, to ignore history storing based on keyword in title or url
-Clicking items in Recent History inside popup now opens them in new tab, without focusing on that page

Fixed/changed in version 4.1.0:
-Bookmarks loading speed fixed
-Bookmarks search input clear button added
-Bookmarks search loading speed increased
-Added scroll to bottom which scrolls by 1 visible page length
-Added more translations
-Bookmarks multiple selection mode added

Fixed/changed in version 4.1.1:
-Added wallpaper mode with frosted UI look
-Fixed reading mode calendar
-Added reading mode filters
-Fixed context menu for reading mode
-Added option for wallpaper hue
-CSS fixes
  
Fixed/changed in version 4.1.2:
-Added option to auto store tabs that haven't been focused on for configured amount of time
-Added option to migrate storage to use IndexedDB instead of localStorage (good for big history, but more vulnerable to malware and breaking, so not recommended)
-Fixed random wallpaper switching speed
-Added option to show URLs under site titles in popup
-Fixed website title changing consuming CPU (example title change on message recieved)  

Fixed/changed in version 4.1.3:
-Added option to export tabs for devices
-Changes in favicon functions
-Fixed speed of tab unstoring
-Added preview for current year when scrolling date pills

Fixed/changed in version 4.1.4:
-Fixed loading speed when switching between dates, now it's instant with caching
-Added quick filters button
-Added option to change extension icon
-Added option to disable extension showing in context menu
-Added auto export history interval option
-Fixed option of not all tabs showing under devices

Fixed/changed in version 4.1.5:
-Added high contrast mode
-Added sidebar mode
-Fixed quick filter filtering bug
-Added scroll date pills by scroll wheel without holding shift
-Fixed 'URLs' toggle for popup being enabled falsely by default
-Fixed right clicking triggering selection mode in popup

Fixed/changed in version 4.1.6:
-Added search for devices tabs
-Added calendar mode for main page
-Added rounded corners option
-Added delete option for multi selection in popup in tab storage
-Added option to hide sites in time spent list
-Added domain exception list for history deletion
-Added option to disable navigation emoji icons
-Fixed and changed certain CSS styles
-Fixed auto tab storing to not auto store after browser restores after PC was off for long
-Fixed deleting bug if quick filters are applied
-Fixed performance when deleting links individually
-Fixed session restoring to restore in individual windows
-Fixed UI translations for other languages
-Performance improvements 

Fixed/changed in version 4.1.7:
-Changes to default settings
-Added option to move bookmarks inside the list

Fixed/changed in version 4.1.8:
-Changes to default settings
-CSS fixes

Fixed/changed in version 4.1.9:
-Most of translations are fixed
-Added history locking option
-Popup CSS bug fixed
-Exporting bookmarks now also saves bookmarks folders structure 

Fixed/changed in version 4.2.0:
-CSS style fixes (date label, text colors, etc.)
-Fixed missing translations
-Added option to view time spent for any date
-Added optional filter option for popup/sidebar
-Added option to keep saving history while UI is locked
-Added option to search extensions history inside address bar, by pressing q then space or tab (omnibox)
-Added "More from Domain" and "Ignore domain" in context menu for history items
-Updated and expanded the tutorial.html

Fixed/changed in version 4.2.1:
-Major architectural change, database uses now WASM based SQlite to read large history faster.
  Date pills now lazy load to save ram when history is big.
  Also other performance improvements regarding UI loading time.
  Database auto repairs if broken, but needs some time if it's big
-Fixed history deleting bug, that was only deleting counting from current date and not last entry date
-Date pill arrows now switch between dates
-Right clicking date pill arrows or next/prev date buttons now skips to oldest or newest date
-Reading mode is now using only calendar mode for faster history browsing
-Locking UI now works for larger history too, but without encryption if it's too big
-Added option to import .tsv files from History Trends Unlimited
-Changed Auto export behavior to not delete history on auto export (was bad choice to make it like that)
-Added option to auto export and upload to WebDAV server
-Hidden "History storage engine" option, as it's no longer needed, default is SQlite WASM if history is big it auto switches
-Added new icon options
-Fixed missing translation (still not complete)
-Auto fade animation when switching dates now enabled by default for better experience
-Added import/export/delete progress notification bubbles
-Added average visits by hour of day in Activity tab
-Added average time per weekday (all time) in Time Spent tab

Fixed/changed in version 4.2.2:
-Fixed black flashing when using light mode
-Fixed "Average visits by hour of day" not highlighting based current time
-Added follow system theme option
-Moving cursor over "Daily visits — 90 days" chart shows data for each day now
-"Average time per weekday" chart is now based on "All time" or 7,15,30,90 days based on selection
</pre>



