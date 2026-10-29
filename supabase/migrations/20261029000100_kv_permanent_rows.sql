-- User settings, share links and the DPoP key must never expire. The app treats a null
-- expires_at as "never" (src/storage.js, expMs), so this only runs after that code is live.
update kv set expires_at = null
where key like 'alertprefs:%'
   or key like 'wishlist:%'
   or key like 'share:%'
   or key = 'dpop:key';
