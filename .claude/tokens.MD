Here's how it works:                  
                                        
  ---                                   
  The Two Tokens                        
                                    
  Access token — short-lived (1 hour).
  Used on every QB API call like a key
  card. QB checks it every time you make
   a request.                    
                                      
  Refresh token — long-lived (100 days).
   Used only to get a new access token  
  when the old one expires. Think of it
  as a master key that mints new key    
  cards.                              
                                        
  Both are stored in your qb_tokens
  table after you authorize.            
                                      
  ---
  What Happens Automatically
                            
  Every time your server makes a QB API
  call, it runs getValidAccessToken()
  which does this:
                                 
  Is the access token expiring in the 
  next 5 minutes?                   
    NO  → use it as-is                  
    YES → call QB's refresh endpoint
  using the refresh token               
          → get a brand new access token
   (and sometimes a new refresh token)  
          → save both to qb_tokens    
          → use the new access token    
                                        
  So the access token silently renews
  itself every hour, forever, without   
  you doing anything.                 
                                        
  ---                                   
  The Refresh Token's 100-Day Clock     
                                        
  The refresh token resets its 100-day  
  timer every time it's used. Since your
   server refreshes the access token  
  every hour, the refresh token gets
  used multiple times a day — so in     
  practice it never expires on an active
   server.                              
                                      
  The only way it actually expires is if
   your server is completely offline and
   makes zero QB calls for 100 straight
  days.                               

  ---                                   
  On a Real Hosted Server
                                        
  The flow is:                        
                                    
  1. Deploy to Railway/Render
  2. Open                        
  https://yourdomain.com/api/auth/qb  
  once in your browser
  3. Log in with the SevenStarFoods QB  
  account and authorize               
  4. Tokens saved to your hosted        
  database                              
  5. Done — never touch it again      
                                        
  From that point, every order push,    
  every sync, every webhook call just
  works. The server refreshes tokens    
  silently in the background.         
                                        
          → save both to qb_tokens
          → use the new access token

  So the access token silently renews itself every hour, forever, without you
  doing anything.

  ---
  The Refresh Token's 100-Day Clock

  The refresh token resets its 100-day timer every time it's used. Since your
  server refreshes the access token every hour, the refresh token gets used
  multiple times a day — so in practice it never expires on an active server.

  The only way it actually expires is if your server is completely offline and
  makes zero QB calls for 100 straight days.

  ---
  On a Real Hosted Server

  The flow is:

  1. Deploy to Railway/Render
  2. Open https://yourdomain.com/api/auth/qb once in your browser
  3. Log in with the SevenStarFoods QB account and authorize
  4. Tokens saved to your hosted database
  5. Done — never touch it again

  From that point, every order push, every sync, every webhook call just works.
  The server refreshes tokens silently in the background.

  ---
  When Would You Ever Need to Re-Authorize?

  - You manually revoke the app's access in QB settings
  - Server is down for 100+ days with no QB activity (extremely unlikely)
  - You wipe the database (including qb_tokens)
  - You change your QB_CLIENT_ID or QB_CLIENT_SECRET

  That's it. Normal day-to-day operation requires zero manual token management.
