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

Fixed/changed in version 4.0.8 (waiting for Chrome Store to review and approve update): 
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

Fixed/changed in version 4.0.9 (not released on Github or Store yet, until tested):
-Ignore lists now require password to be seen (easy password reset)
-Searched results in popup can now be deleten
-Stored tabs can be unstored now inside popup
-Fixed auto session export .html file to include windows grouping and tab storage now
-Bookmarks now show date added next to them
-Disabled time pills when using "All" filter
-Added keyword option in ignore lists, to ignore history storing based on keyword in title or url
</pre>



