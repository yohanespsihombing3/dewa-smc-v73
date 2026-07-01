//+------------------------------------------------------------------+
//| DEWA SMC Priority EA MT5 V7.5                                    |
//| SMC A/A+ priority, then SNIPER A/A+. HYBRID ignored.             |
//| TP1 market + TP2/TP3 pending chain placed at once if enabled.    |
//+------------------------------------------------------------------+
#property strict
#include <Trade/Trade.mqh>

CTrade trade;

input string SignalURL = "https://dewa-smc-ai.onrender.com/api/ea/latest-signal";
input string MemberEmail = "";
input string EAApiKey = "";
input string TimeframeText = "5m";

input double LotTP1 = 0.01;
input double LotTP2 = 0.01;
input double LotTP3 = 0.01;

input bool EnableTP2 = true;
input bool EnableTP3 = true;

input int CheckSeconds = 20;
input int MaxSpreadPoints = 300;
input long Magic = 696969;

input bool OneSetupPerSymbol = true;
input bool PreventSameSignalReEntry = true;

string lastKey = "";
string sigSide = "";
string sigEngine = "";

double sigEntry = 0.0;
double sigTP1 = 0.0;
double sigTP2 = 0.0;
double sigTP3 = 0.0;
double sigSL = 0.0;

string LastKeyGV()
{
   return "DEWA_LAST_SIGNAL_" + _Symbol + "_" + IntegerToString((int)Magic);
}

string UrlEncode(string s)
{
   StringReplace(s,"@","%40");
   StringReplace(s,"/","%2F");
   StringReplace(s," ","%20");
   StringReplace(s,"+","%2B");
   return s;
}

bool IsLong()
{
   return sigSide=="OPEN LONG" || sigSide=="REVERSE LONG";
}

bool IsShort()
{
   return sigSide=="OPEN SHORT" || sigSide=="REVERSE SHORT";
}
double NormalizePrice(double price){ return NormalizeDouble(price,_Digits); }

double NormalizeVolume(double lots)
{
   double minLot = SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   double step   = SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0) step=0.01;
   lots = MathMax(minLot, MathMin(maxLot, lots));
   lots = MathFloor(lots / step) * step;
   return NormalizeDouble(lots, 2);
}

bool HasDewaPosition()
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
      {
         if(PositionGetInteger(POSITION_MAGIC)==Magic && PositionGetString(POSITION_SYMBOL)==_Symbol)
            return true;
      }
   }
   return false;
}

bool HasDewaOrder()
{
   for(int i=OrdersTotal()-1;i>=0;i--)
   {
      ulong ticket=OrderGetTicket(i);
      if(OrderSelect(ticket))
      {
         if(OrderGetInteger(ORDER_MAGIC)==Magic && OrderGetString(ORDER_SYMBOL)==_Symbol)
            return true;
      }
   }
   return false;
}

void DeleteAllDewaOrders()
{
   for(int i=OrdersTotal()-1;i>=0;i--)
   {
      ulong ticket=OrderGetTicket(i);
      if(OrderSelect(ticket))
      {
         if(OrderGetInteger(ORDER_MAGIC)==Magic && OrderGetString(ORDER_SYMBOL)==_Symbol)
            trade.OrderDelete(ticket);
      }
   }
}

void CloseAllDewaPositions()
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
      {
         if(PositionGetInteger(POSITION_MAGIC)==Magic && PositionGetString(POSITION_SYMBOL)==_Symbol)
            trade.PositionClose(ticket);
      }
   }
}

void EmergencyCloseAll()
{
   DeleteAllDewaOrders();
   CloseAllDewaPositions();
}

double JsonNumber(string json,string key)
{
   string p="\""+key+"\":";
   int i=StringFind(json,p);
   if(i<0)return 0.0;
   i+=StringLen(p);
   while(i<StringLen(json))
   {
      ushort ch=StringGetCharacter(json,i);
      if(ch!=' ' && ch!='"')break;
      i++;
   }
   int j=i;
   while(j<StringLen(json))
   {
      ushort ch=StringGetCharacter(json,j);
      if(ch==',' || ch=='}' || ch=='"')break;
      j++;
   }
   return StringToDouble(StringSubstr(json,i,j-i));
}

string JsonString(string json,string key)
{
   string p="\""+key+"\":";
   int i=StringFind(json,p);
   if(i<0)return "";
   i+=StringLen(p);
   while(i<StringLen(json) && StringGetCharacter(json,i)!='"')i++;
   i++;
   int j=i;
   while(j<StringLen(json) && StringGetCharacter(json,j)!='"')j++;
   return StringSubstr(json,i,j-i);
}

bool ValidGrade(string json)
{
   string grade = JsonString(json,"grade");
   StringToUpper(grade);
   return grade=="A" || grade=="A+";
}

double SignalHash(string s)
{
   double h=0;
   for(int i=0;i<StringLen(s);i++)
      h = MathMod(h*131 + StringGetCharacter(s,i), 1000000007);
   return h;
}

bool IsSameSignalAlreadyUsed()
{
   if(!PreventSameSignalReEntry)return false;
   if(!GlobalVariableCheck(LastKeyGV()))return false;
   return MathAbs(GlobalVariableGet(LastKeyGV()) - SignalHash(lastKey)) < 0.1;
}

void MarkSignalUsed()
{
   if(PreventSameSignalReEntry)
      GlobalVariableSet(LastKeyGV(), SignalHash(lastKey));
}

bool SpreadOK()
{
   int spread=(int)SymbolInfoInteger(_Symbol,SYMBOL_SPREAD);
   if(spread>MaxSpreadPoints)
   {
      Print("Spread too high: ",spread);
      return false;
   }
   return true;
}

bool FetchSignal()
{
   string url=SignalURL+
      "?key="+EAApiKey+
      "&email="+UrlEncode(MemberEmail)+
      "&symbol="+_Symbol+
      "&tf="+UrlEncode(TimeframeText)+
      "&mt5="+IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN));

   char post[],result[];
   string headers;
   ResetLastError();

   int code=WebRequest("GET",url,"",10000,post,result,headers);
   if(code!=200)
   {
      Print("DEWA EA WebRequest failed. code=",code," err=",GetLastError());
      return false;
   }

   string json=CharArrayToString(result);
   if(StringFind(json,"\"signal\":null")>=0)return false;

   string signal=JsonString(json,"signal");
   string engine=JsonString(json,"engine");

   if(StringFind(engine,"HYBRID")>=0)return false;
   if(StringFind(engine,"SMC")<0 && StringFind(engine,"SNIPER")<0)return false;
   if(
   signal!="OPEN LONG" &&
   signal!="OPEN SHORT" &&
   signal!="REVERSE LONG" &&
   signal!="REVERSE SHORT"
)
   return false;
   if(!ValidGrade(json))return false;

   double entry=JsonNumber(json,"entry");
   double tp1=JsonNumber(json,"tp1");
   double tp2=JsonNumber(json,"tp2");
   double tp3=JsonNumber(json,"tp3");
   double sl=JsonNumber(json,"sl");

   if(entry<=0 || tp1<=0 || sl<=0)return false;
   if(EnableTP2 && tp2<=0)return false;
   if(EnableTP3 && tp3<=0)return false;

   sigEngine=engine;
   sigSide=signal;
   sigEntry=NormalizePrice(entry);
   sigTP1=NormalizePrice(tp1);
   sigTP2=NormalizePrice(tp2);
   sigTP3=NormalizePrice(tp3);
   sigSL=NormalizePrice(sl);

   lastKey=engine+"-"+signal+"-"+DoubleToString(sigEntry,_Digits)+"-"+DoubleToString(sigTP1,_Digits)+"-"+DoubleToString(sigSL,_Digits);

   return true;
}

bool IsValidLongChain()
{
   if(!(sigTP1>sigEntry && sigSL<sigEntry))return false;
   if(EnableTP2 && !(sigTP2>sigTP1))return false;
   if(EnableTP3 && !(sigTP3>sigTP2))return false;
   return true;
}

bool IsValidShortChain()
{
   if(!(sigTP1<sigEntry && sigSL>sigEntry))return false;
   if(EnableTP2 && !(sigTP2<sigTP1))return false;
   if(EnableTP3 && !(sigTP3<sigTP2))return false;
   return true;
}

bool PlaceMarketTP1()
{
   double lot=NormalizeVolume(LotTP1);
   if(lot<=0)return false;

   trade.SetExpertMagicNumber(Magic);

   bool ok=false;
   if(IsLong())
      ok=trade.Buy(lot,_Symbol,0,NormalizePrice(sigSL),NormalizePrice(sigTP1),"DEWA TP1 MARKET");
   else if(IsShort())
      ok=trade.Sell(lot,_Symbol,0,NormalizePrice(sigSL),NormalizePrice(sigTP1),"DEWA TP1 MARKET");

   if(!ok) Print("TP1 market failed: ",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
   return ok;
}

bool PlacePendingTP2()
{
   if(!EnableTP2 || LotTP2<=0)return true;

   double lot=NormalizeVolume(LotTP2);
   trade.SetExpertMagicNumber(Magic);

   bool ok=false;

   // TP2 entry = TP1, SL = original entry, TP = TP2
   if(IsLong())
      ok=trade.BuyStop(lot,NormalizePrice(sigTP1),_Symbol,NormalizePrice(sigEntry),NormalizePrice(sigTP2),ORDER_TIME_GTC,0,"DEWA TP2 PENDING");
   else if(IsShort())
      ok=trade.SellStop(lot,NormalizePrice(sigTP1),_Symbol,NormalizePrice(sigEntry),NormalizePrice(sigTP2),ORDER_TIME_GTC,0,"DEWA TP2 PENDING");

   if(!ok) Print("TP2 pending failed: ",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
   return ok;
}

bool PlacePendingTP3()
{
   if(!EnableTP3 || LotTP3<=0)return true;

   double lot=NormalizeVolume(LotTP3);
   trade.SetExpertMagicNumber(Magic);

   bool ok=false;

   // TP3 entry = TP2, SL = TP1, TP = TP3
   if(IsLong())
      ok=trade.BuyStop(lot,NormalizePrice(sigTP2),_Symbol,NormalizePrice(sigTP1),NormalizePrice(sigTP3),ORDER_TIME_GTC,0,"DEWA TP3 PENDING");
   else if(IsShort())
      ok=trade.SellStop(lot,NormalizePrice(sigTP2),_Symbol,NormalizePrice(sigTP1),NormalizePrice(sigTP3),ORDER_TIME_GTC,0,"DEWA TP3 PENDING");

   if(!ok) Print("TP3 pending failed: ",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
   return ok;
}

bool PlaceFullSetup()
{
   if(!SpreadOK())return false;

   if(IsLong() && !IsValidLongChain())
   {
      Print("Invalid LONG chain.");
      return false;
   }

   if(IsShort() && !IsValidShortChain())
   {
      Print("Invalid SHORT chain.");
      return false;
   }

   if(IsSameSignalAlreadyUsed())
   {
      Print("Same signal already used. Skip.");
      return false;
   }

   if(OneSetupPerSymbol && (HasDewaPosition() || HasDewaOrder()))
   {
      Print("Existing DEWA setup detected. Skip new setup.");
      return false;
   }

   if(!PlaceMarketTP1())return false;

   bool ok2=PlacePendingTP2();
   bool ok3=PlacePendingTP3();

   if(!ok2 || !ok3)
   {
      Print("Pending setup incomplete. Closing all.");
      EmergencyCloseAll();
      return false;
   }

   MarkSignalUsed();

   Print("DEWA setup placed: ",sigEngine," ",sigSide,
         " | TP1 market | TP2 pending at ",sigTP1,
         " | TP3 pending at ",sigTP2);

   return true;
}

int OnInit()
{
   EventSetTimer(CheckSeconds);
   trade.SetExpertMagicNumber(Magic);
   Print("DEWA SMC Priority EA V7.5 started.");
   Print("Rule: TP1 market + TP2/TP3 pending chain. SMC priority, then SNIPER A/A+. HYBRID ignored.");
   Print("Allow WebRequest URL in MT5 settings.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(OneSetupPerSymbol && (HasDewaPosition() || HasDewaOrder()))
      return;

   if(FetchSignal())
      PlaceFullSetup();
}

void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
{
   if(trans.type==TRADE_TRANSACTION_DEAL_ADD)
   {
      HistorySelect(TimeCurrent()-86400*14,TimeCurrent());
      ulong deal=trans.deal;

      if(HistoryDealSelect(deal))
      {
         long magic=HistoryDealGetInteger(deal,DEAL_MAGIC);
         string symbol=HistoryDealGetString(deal,DEAL_SYMBOL);
         long entry=HistoryDealGetInteger(deal,DEAL_ENTRY);
         double profit=HistoryDealGetDouble(deal,DEAL_PROFIT);
         string comment=HistoryDealGetString(deal,DEAL_COMMENT);

         if(magic==Magic && symbol==_Symbol && entry==DEAL_ENTRY_OUT && profit<0)
         {
            Print("DEWA EA detected SL/loss on ",comment,". Closing all DEWA positions and deleting pending orders.");
            EmergencyCloseAll();
         }
      }
   }
}
