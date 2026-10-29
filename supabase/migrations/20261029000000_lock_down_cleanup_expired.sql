-- cleanup_expired() is SECURITY DEFINER and was callable by anon/authenticated through
-- /rest/v1/rpc/cleanup_expired. Only the service role (the app) may run it.
alter function public.cleanup_expired() set search_path = public;
revoke execute on function public.cleanup_expired() from public, anon, authenticated;
-- service_role only has EXECUTE through PUBLIC today; grant it back so cleanup keeps working
grant execute on function public.cleanup_expired() to service_role;
