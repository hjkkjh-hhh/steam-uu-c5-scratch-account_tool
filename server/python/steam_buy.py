#!/usr/bin/env python3
"""
steam_buy.py — Steam Market Purchase Bridge (via steampy)
Bypass "Use login method first" by using _session directly.
"""

import sys
import json
import time
import requests
from steampy.client import SteamClient
from urllib3.exceptions import InsecureRequestWarning

# Suppress SSL warnings
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

def buy_listing_steampy(params: dict) -> dict:
    cookie_str    = params.get('cookie', '')
    listing_id    = str(params.get('listingId', ''))
    subtotal      = int(round(float(params.get('subtotal', 0))))
    fee           = int(round(float(params.get('fee', 0))))
    total         = int(round(float(params.get('total', 0))))
    currency      = int(params.get('currency', 23))
    mafile_str    = params.get('mafile', None)

    if not cookie_str:
        return {'success': False, 'message': 'Cookie未配置'}
    if not listing_id:
        return {'success': False, 'message': '缺少listingId'}

    # 1. Initialize SteamClient
    guard_data = None
    if mafile_str:
        try:
            guard_data = json.loads(mafile_str)
        except:
            pass

    client = SteamClient(api_key="") 
    if guard_data:
        client.steam_guard = guard_data
        client.was_login_executed = True
    
    # Extract sessionid more robustly and INJECT cookies
    session_id = ""
    for part in cookie_str.split(';'):
        p = part.strip()
        if p.lower().startswith('sessionid='):
            session_id = p.split('=')[1]
        
        if '=' in p:
            k, _, v = p.partition('=')
            client._session.cookies.set(k.strip(), v.strip(), domain='steamcommunity.com')
            client._session.cookies.set(k.strip(), v.strip(), domain='.steamcommunity.com')
    
    # DEBUG: Log the extracted sessionid
    sys.stderr.write(f"DEBUG: Using SessionID: {session_id}\n")
    sys.stderr.flush()

    # Force regional cookies
    if currency == 23:
        client._session.cookies.set('steamCountry', 'CN', domain='steamcommunity.com')
        client._session.cookies.set('steamCurrencyId', '23', domain='steamcommunity.com')

    # 2. Execute Purchase (Bypassing the higher-level "login" lock)
    url = f"https://steamcommunity.com/market/buylisting/{listing_id}"
    data = {
        "sessionid": session_id,
        "currency": str(currency),
        "subtotal": str(subtotal),
        "fee": str(fee),
        "total": str(total),
        "quantity": "1",
        "billing_state": "",
        "save_my_address": "0"
    }
    
    # Configure Proxy for Session
    port = params.get('proxyPort')
    if port:
        proxy_url = f"http://127.0.0.1:{port}"
        client._session.proxies = {"http": proxy_url, "https": proxy_url}
        sys.stderr.write(f"DEBUG: Using Proxy: {proxy_url}\n")
        sys.stderr.flush()
    else:
        sys.stderr.write(f"DEBUG: No proxy configured (proxyPort={port})\n")
        sys.stderr.flush()
    
    # DEBUG: Log the full request data
    sys.stderr.write(f"DEBUG: Request Data: {json.dumps(data)}\n")
    sys.stderr.flush()
    
    headers = {
        "Referer": f"https://steamcommunity.com/market/listings/730/{params.get('marketHashName', '')}",
        "Origin": "https://steamcommunity.com",
        "X-Requested-With": "XMLHttpRequest"
    }

    try:
        # Use our client's session
        resp = client._session.post(url, data=data, headers=headers, timeout=30)
        
        # DEBUG: Log raw status and text
        sys.stderr.write(f"DEBUG: HTTP Status: {resp.status_code}\n")
        sys.stderr.write(f"DEBUG: Steam Response (raw): {resp.text}\n")
        sys.stderr.flush()
        
        try:
            response = resp.json()
        except:
            return {'success': False, 'message': f'Steam返回了非JSON内容 (HTTP {resp.status_code})', 'isStale': False}
        
        if response is None:
            return {'success': False, 'message': f'Steam返回了空响应 (HTTP {resp.status_code})', 'isStale': False}
        
        # NOTE: Do not return early on 502 because Steam often returns 502 with a valid JSON 
        # {"message": "...The listing may have been removed..."} when a listing is already sold.
        
        status = response.get('success')
        # Typical success is 1. If success=22, it might still mean already purchased or confirmation needed
        if status == 1 or response.get('wallet_info') or status == 22 or response.get('requires_confirmation'):
            needs_mobile = response.get('requires_confirmation') or response.get('needs_mobile_confirmation') or status == 22
            
            # 3. Handle Auto-Confirmation via steampy if needed
            if needs_mobile:
                if not guard_data:
                    return {'success': True, 'message': '已下单成功，但账号缺失maFile，请手动手机确认'}
                
                time.sleep(2.5) # Wait for Steam to register the confirmation
                try:
                    confirmations = client.get_confirmations()
                    target_conf = None
                    for conf in confirmations:
                        target_conf = conf # Use most recent
                        break
                    
                    if target_conf:
                        client.confirm_transaction(target_conf.id)
                        return {'success': True, 'message': '购买成功！(已自动完成手机确认)'}
                    else:
                        return {'success': True, 'message': '已下单，但未在秒内嗅探到确认单，建议检查手机'}
                except Exception as ce:
                    return {'success': True, 'message': f'已下单，自动确认组件异常: {str(ce)}'}
            
            return {'success': True, 'message': '购买成功！(无需确认)'}

        msg = response.get('message', f'Steam失败码: {status}')
        # Mark isStale for true 404-equivalent responses AND when the message explicitly says it's removed.
        # Steam occasionally returns 500 or 502 when the listing is already sold.
        is_stale = resp.status_code == 404 or ('removed' in msg.lower()) or ('not found' in msg.lower())
        return {
            'success': False,
            'message': f'Steam错误(HTTP {resp.status_code}): {msg}',
            'isStale': is_stale
        }

    except Exception as e:
        msg = str(e)
        return {'success': False, 'message': f'发包异常: {msg}', 'potentialSuccess': "50" in msg}

def main():
    try:
        raw = sys.stdin.read()
        if not raw: return
        params = json.loads(raw)
        result = buy_listing_steampy(params)
    except Exception as e:
        result = {'success': False, 'message': f'初始化失败: {str(e)}'}

    sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')

if __name__ == '__main__':
    main()
